// ============================================================
//  index.ts  -  subir e descer, na ordem certa.
//
//  A subida:
//
//      config  ->  banco  ->  migrações  ->  HTTP
//
//  A descida é a mesma lista de trás para frente, e ela existe
//  porque o processo é 24/7: fechar mal deixa socket aberto,
//  relógio batendo e banco em WAL sem checkpoint.
//
//  ------------------------------------------------------------
//  ####  NO WINDOWS, SINAL NÃO É SINAL  ####
//
//  `process.kill(pid, 'SIGINT')` chama o TerminateProcess: o
//  processo morre na hora e o handler de SIGINT/SIGTERM NÃO roda.
//  O que funciona igual nos dois sistemas é IPC — daí o
//  `shutdown_with_message: true` no ecosystem.config.cjs e o
//  `process.on('message')` aqui embaixo.
//
//  Os handlers de sinal ficam mesmo assim: no Ctrl+C do terminal
//  eles funcionam, e é assim que se desenvolve.
// ============================================================

import { randomUUID } from 'node:crypto';

import { OperatorAuth } from './auth/operator.js';
import { BanExpiryWatcher } from './bans/expiry-watcher.js';
import { BanList } from './bans/service.js';
import { ConfigError, loadConfig } from './config.js';
import { BansRepository } from './db/bans-repository.js';
import { openDatabase } from './db/database.js';
import { KitsRepository } from './db/kits-repository.js';
import { LoadoutsRepository } from './db/loadouts-repository.js';
import { runMigrations } from './db/migrations.js';
import { ItemsRepository } from './db/items-repository.js';
import { PlayersRepository } from './db/players-repository.js';
import { PluginsRepository } from './db/plugins-repository.js';
import { ServersRepository } from './db/servers-repository.js';
import { SpawnStatusRepository } from './db/spawn-status-repository.js';
import { UiDocumentsRepository } from './db/ui-documents-repository.js';
import { ItemCatalog } from './game/item-catalog.js';
import { VipsRepository } from './db/vips-repository.js';
import { KitStore } from './kits/service.js';
import { SpawnStatusSync } from './loadouts/status.js';
import { LoadoutSync } from './loadouts/sync.js';
import { VipExpiryWatcher } from './vip/expiry-watcher.js';
import { VipList } from './vip/service.js';
import { VipSiteMirror } from './vip/site-mirror.js';
import { MapImageKeeper } from './game/map-image.js';
import { MonumentReader } from './game/monuments.js';
import { PlayersReader, type PlayersSnapshot } from './game/players.js';
import { loadUiImages } from './game/ui-images.js';
import { buildKitsScreen, KITS_SCREEN_ID, parseKitScreenId } from './game/ui-kits-screen.js';
import { buildMainMenu } from './game/ui-preset-main-menu.js';
import {
  buildResult,
  createHeaderProvider,
  createStoreBuyHandler,
  createStoreScreenProvider,
} from './game/ui-store-bridge.js';
import { UiSync } from './game/ui-sync.js';
import { WipeClock } from './game/wipe.js';
import { StoreRepository } from './db/store-repository.js';
import { WalletsRepository } from './db/wallets-repository.js';
import { StoreService } from './store/service.js';
import { LocalWallet, type Wallet } from './store/wallet.js';
import { SiteWallet } from './store/site-wallet.js';
import { SiteClient } from './site/client.js';
import { SiteBeacon } from './site/beacon.js';
import { PurchaseSettler } from './store/settle.js';
import { SiteDeliveries } from './site/deliveries.js';
import { SiteCommands } from './site/commands.js';
import { SiteConfig } from './site/config.js';
import {
  SiteDomainConfig,
  SITE_DOMAINS,
  type DomainApplier,
  type SiteDomainLoop,
} from './site/domains.js';
import { storeApplier } from './site/appliers/store.js';
import { kitsApplier } from './site/appliers/kits.js';
import { vipsApplier } from './site/appliers/vips.js';
import { SiteStatus } from './site/status.js';
import { CatalogMirror } from './store/catalog-mirror.js';
import { MetaRepository } from './db/meta-repository.js';
import { normalizeSiteBaseUrl, SITE_BASE_URL_KEY } from './site/settings.js';
import { SiteDeliveriesRepository } from './db/site-deliveries-repository.js';
import { SiteCommandsRepository } from './db/site-commands-repository.js';
import { diskUsage } from './util/disk.js';
import type { SitePairedServer } from './http/routes/site.js';
import { primaryMac } from './site/mac.js';
import { buildReference } from './store/reference.js';
import { VERSION } from './version.js';
import { toGeneratedScreenBundle } from './types/ui-transport.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { OperationLock, OperationStore } from './ops/operations.js';
import { PluginLibrary } from './oxide/library.js';
import { OxideRuntimeMonitor } from './oxide/runtime.js';
import { PresenceTracker, PresenceWatcher } from './players/presence.js';
import { PlayerDirectory } from './players/service.js';
import { ServerSupervisor } from './servers/supervisor.js';
import { SteamUpdateWatcher } from './steam/update-watcher.js';
import { toError } from './util.js';
// ---- wipe, calendário e mensagens ----
import { WipeScheduleRepository } from './db/wipe-schedule-repository.js';
// ---- o wipe: a fila de mapas ----
import { MapPoolRepository } from './db/map-pool-repository.js';
import { WipeRunsRepository } from './db/wipe-runs-repository.js';
import { WipesRepository } from './db/wipes-repository.js';
import { currentWorldReader } from './wipe/next-wipe.js';
import { WipeRunner, type WipeExecutor } from './wipe/run.js';
import { WipeScheduler } from './wipe/scheduler.js';
// ---- as mensagens agendadas ----
import { MessagesRepository } from './db/messages-repository.js';
import { PluginBroadcaster } from './game/broadcast.js';
import { MessagesService } from './messages/service.js';
import { VariableRegistry, registerCoreVariables } from './messages/variables.js';
// ---- o wipe: a prévia do mapa (RustMaps) ----
import { RustMapsWatcher } from './wipe/rustmaps-poll.js';
import { RustMapsClient } from './wipe/rustmaps.js';
// ---- o wipe: os blueprints que sobrevivem ----
import { BpRepository } from './db/bp-repository.js';
import { BlueprintService } from './wipe/blueprints.js';
// ---- a ponte: os avisos de wipe são mensagens (Docs\16 §11) ----
import { registerWipeVariables } from './messages/providers/wipe.js';
import { WipeBroadcastAnnouncer } from './wipe/announce.js';
// ---- o calendário dentro do jogo (Docs\16 §9.3) ----
import {
  buildEmptyCalendarBundle,
  createCalendarScreenProvider,
  isCalendarScreenId,
  type CalendarScreenProvider,
} from './game/ui-calendar-screen.js';
import { readVipTiers } from './vip/tiers.js';

/** Orçamento do desligamento limpo. Ver o kill_timeout do PM2 (25 s). */
const SHUTDOWN_TIMEOUT_MS = 15_000;


async function main(): Promise<void> {
  const startedAt = Date.now();

  // ---- 1. configuração -------------------------------------
  //
  // Antes do logger de propósito: é a configuração que diz em que
  // nível e formato o log sai. Uma configuração inválida imprime
  // no console cru e sai com 1 — e isso é melhor que um log
  // bonito de um agente que não vai funcionar.
  let loaded;

  try {
    loaded = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[RustAgent] ${error.message}\n`);
      process.exit(1);
    }

    throw error;
  }

  const { agent, servers, rejected } = loaded;
  const logger = createLogger({ log: agent.log });

  logger.info(
    {
      version: VERSION,
      root: agent.paths.root,
      servers: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
    },
    'RustAgent subindo',
  );

  for (const problem of rejected) {
    logger.warn({ server: problem.id }, `Configs\\${problem.id}.ini foi IGNORADO: ${problem.reason}`);
  }

  if (servers.length === 0) {
    logger.warn(
      { configsDir: agent.paths.configsDir },
      'nenhum servidor configurado ainda — crie o primeiro pelo painel, em Servidores',
    );
  }

  // ---- 2. banco --------------------------------------------
  const db = openDatabase({ file: agent.paths.dbPath, logger });
  const applied = runMigrations(db, logger);

  if (applied.length > 0) {
    logger.info({ count: applied.length }, 'migrações aplicadas');
  }

  // ---- 3. os servidores -------------------------------------
  //
  // O supervisor reconcilia a tabela a partir dos `.ini` e monta
  // o contexto de quem está ligado E instalado. Quem não está
  // fica com o serviço restrito — só a operação de instalar.
  const repository = new ServersRepository(db);
  const operations = new OperationStore();
  const lock = new OperationLock();

  // ####  A INDIREÇÃO AQUI NÃO É PREGUIÇA  ####
  //
  // O supervisor precisa avisar a BanList quando um RCON conecta, e
  // a BanList precisa do supervisor para saber quais servidores
  // existem. Um dos dois tem de ser montado primeiro, e quem manda
  // nessa ordem é o RCON: o contexto de um servidor ligado começa a
  // conectar dentro do `mountAll`.
  //
  // A variável resolve isso sem inverter a montagem: o gancho
  // existe desde o começo e passa a ter dono quando a BanList
  // nasce, poucas linhas abaixo. Uma conexão que suba antes disso
  // não perde a reconciliação — ela acontece no `reconcileAll` do
  // boot.
  let bans: BanList | null = null;
  let mapImages: MapImageKeeper | null = null;
  let presence: PresenceTracker | null = null;
  // Pela mesma razão dos de cima: o catálogo de itens confere na
  // reconexão do RCON, e a interface é reenviada por ela.
  let itemCatalog: ItemCatalog | null = null;
  let uiSync: UiSync | null = null;
  // Os dois da fase de VIP e kits, pela MESMA razão dos de cima:
  // eles precisam do supervisor, e o gancho de reconexão precisa
  // deles. Ver o bloco de montagem, mais abaixo.
  let vips: VipList | null = null;
  let loadoutSync: LoadoutSync | null = null;
  let spawnStatusSync: SpawnStatusSync | null = null;
  // A página CALENDÁRIO do menu do jogo, pela mesma razão: ela lê a
  // agenda e a fila de mapas, que nascem bem abaixo, e quem a chama
  // é o `generatedScreens` do `UiSync`, que só corre no clique do
  // jogador. `null` = ainda não montada, e aí a tela do documento
  // responde no lugar.
  let calendarScreens: CalendarScreenProvider | null = null;

  // ####  A HORA DO WIPE VEM DO SERVIDOR  ####
  //
  // `SaveCreatedTime` do `serverinfo` — ver game/wipe.ts. Ele é
  // cacheado até o RCON reconectar, que é o único momento em que um
  // wipe pode ter acontecido.
  const wipeClock = new WipeClock({ logger });

  // ####  O RUNNER DO WIPE CHEGA DEPOIS DO SUPERVISOR  ####
  //
  // Ele precisa do supervisor (para `updateSettings`) e do
  // `Broadcaster` (que precisa do supervisor também); o supervisor
  // precisa dele para entregá-lo a cada `OperationsService`. Um dos
  // dois tem que chegar depois — e o encaminhador abaixo é o mesmo
  // padrão que este arquivo já usa para o VIP, os banimentos e a
  // presença.
  let wipeRunner: WipeExecutor | null = null;

  const supervisor = new ServerSupervisor({
    paths: agent.paths,
    store: operations,
    lock,
    logger,
    startTimeoutMs: agent.ops.startTimeoutMs,
    repository,
    // O RCON conectar é o instante em que o agente volta a alcançar
    // o servidor: é quando a lista de banidos pode ter divergido, e
    // é quando dá para saber qual mundo está carregado.
    onRconConnected: (serverId) => {
      void bans?.reconcile(serverId);
      void mapImages?.ensure(serverId);
      // E a presença pelo mesmo motivo da lista de banidos: enquanto
      // os dois lados não se falam, quem entrou e quem saiu passou
      // sem ninguém ver. É aqui que as sessões que ficaram abertas
      // são fechadas — ver players/presence.ts.
      void presence?.sync(serverId);
      // O catálogo de itens envelhece com a VERSÃO DO JOGO, e não
      // com o tempo: um update da Facepunch reinicia o servidor, e
      // este é o instante em que dá para descobrir isso. Ver
      // game/item-catalog.ts.
      void itemCatalog?.sync(serverId);
      // E a hora do wipe pela MESMA razão: para o save mudar, o
      // servidor precisou parar e subir — e é exatamente isso que
      // acabou de acontecer.
      wipeClock.forget(serverId);
      // E a interface porque o cache dela vive na memória do
      // plugin: um servidor que subiu agora não tem menu nenhum
      // até alguém mandar.
      uiSync?.pushSoon(serverId, 'rcon-connected');

      // ####  E O VIP E OS KITS PELO MESMO MOTIVO — MAIS UM  ####
      //
      // Recarregar um plugin ESVAZIA o cache dele e derruba o RCON
      // junto. Toda (re)conexão repassa os dois estados completos:
      // é o que conserta sozinho wipe, update do jogo, restart do
      // servidor e `oxide.reload`, sem ninguém lembrar de
      // sincronizar na mão.
      void vips?.reconcile(serverId);
      void loadoutSync?.push(serverId, 'rcon-connected');
      // O status de nascimento é o terceiro cache do plugin, e ele
      // esvazia junto com os outros dois.
      void spawnStatusSync?.push(serverId, 'rcon-connected');
    },
    // ####  É POR AQUI QUE O PLUGIN DA INTERFACE PEDE UMA TELA  ####
    //
    // O menu inteiro não cabe num frame de RCON, então só a tela de
    // entrada é empurrada e as outras descem quando o jogador
    // navega. O pedido chega como linha do console — ver
    // game/ui-sync.ts.
    // ####  E AQUI SÓ ENTRA QUEM SABE IGNORAR UMA LINHA  ####
    //
    // Este gancho recebe TODA linha do servidor — centenas por
    // minuto num servidor cheio. Um `sync` chamado daqui vira um
    // laço: ele imprime no console, a linha volta por este mesmo
    // caminho, e o sync dispara de novo. Aconteceu no merge das
    // duas frentes, e o console do jogo virou um paredão de
    // `loadout.sync` repetido.
    //
    // O `handleLine` recusa em duas comparações de string a linha
    // que não é um pedido do plugin de interface.
    onConsoleLine: (serverId, line) => {
      uiSync?.handleLine(serverId, line);
    },
    // Ver o comentário do `let wipeRunner`, logo acima.
    wipeRunner: {
      run: (request) => {
        if (wipeRunner === null) {
          throw new Error(
            'a execução de wipe ainda não terminou de ser montada neste agente; tente de novo em ' +
              'alguns segundos',
          );
        }

        return wipeRunner.run(request);
      },
    },
  });

  supervisor.mountAll(servers);

  // A biblioteca de plugins. A varredura de adoção vem LOGO DEPOIS
  // do `mountAll` porque ela precisa dos servidores já espelhados na
  // tabela `servers` — a chave estrangeira de `server_plugins`
  // aponta para lá.
  //
  // Ela não segura a subida: `void` de propósito, com o erro
  // tratado dentro. Um `.cs` ilegível num servidor não pode adiar a
  // abertura da porta da API.
  // ####  "LIGADO" NÃO É "RODANDO"  ####
  //
  // O acervo sabe que o `.cs` está na pasta; só o Oxide sabe se
  // ele carregou. Este monitor pergunta — e é o que faz o agente
  // perceber sozinho um plugin que parou de compilar depois de um
  // update do Rust, em vez de descobrir horas depois pela tela de
  // Jogadores em branco. Ver `oxide/runtime.ts`.
  const oxideRuntime = new OxideRuntimeMonitor({ servers: supervisor, logger });

  const library = new PluginLibrary({
    libraryDir: agent.paths.pluginLibraryDir,
    repository: new PluginsRepository(db),
    servers: supervisor,
    logger,
    runtime: oxideRuntime,
  });

  void library.adoptAll();

  // Depois da biblioteca, e não antes: a primeira varredura dele
  // fala com o RCON, e nada nesta subida depende do resultado.
  oxideRuntime.start();

  // ---- a lista de banidos -----------------------------------
  //
  // A fonte é a tabela `bans`; cada `bans.cfg` é espelho. A
  // reconciliação do boot NÃO segura a subida (`void`): ela fala
  // com N servidores pelo RCON, e a porta da API não pode esperar
  // por isso. Os servidores que ainda não conectaram entram pelo
  // gancho `onRconConnected`, acima.
  bans = new BanList({
    repository: new BansRepository(db),
    servers: supervisor,
    logger,
  });

  void bans.reconcileAll();

  // O relógio dos banimentos temporários. O ban do Rust é
  // permanente — quem cumpre o prazo é este relógio, e sem ele o
  // `expires_at` seria enfeite.
  const banWatcher = new BanExpiryWatcher({ bans, logger });

  banWatcher.start();

  // A imagem do mapa: desenhada pelo próprio jogo, UMA vez por
  // mundo. O nome do arquivo carrega tamanho e seed, então o wipe
  // refaz o desenho sozinho — e nenhuma subida seguinte repete o
  // trabalho. Ver game/map-image.ts.
  mapImages = new MapImageKeeper({ servers: supervisor, logger });

  // Quem está online. Ele pergunta ao acervo se o OrigemZAgent está
  // ligado naquele servidor e escolhe a fonte — `origemz.players`
  // ou o `playerlist` nativo. A pergunta passa pelo `serverList` do
  // acervo de propósito: ler a tabela de plugins direto daqui seria
  // um segundo caminho para a mesma resposta.
  const players = new PlayersReader({
    plugins: {
      stateOf: async (serverId, pluginName) => {
        const { plugins } = await library.serverList(serverId);
        const found = plugins.find((plugin) => plugin.name === pluginName);

        return { id: found?.id ?? null, enabled: found?.enabled === true };
      },
    },
    // E quem sabe se o Oxide CARREGOU o plugin. É o que separa
    // "ele não compila" de "o servidor estava ocupado" quando o
    // comando não responde — duas coisas que se parecem na tela e
    // pedem o oposto uma da outra.
    runtime: oxideRuntime,
  });

  // Os monumentos do mundo, para o mapa. Nativo do jogo e guardado
  // por seed: eles só mudam no wipe.
  const monuments = new MonumentReader();

  // ---- os jogadores da rede ---------------------------------
  //
  // Até aqui o jogador só existia enquanto conectado: a lista era
  // lida do RCON e jogada fora. `players`/`player_servers` são a
  // identidade dele — e é a elas que o histórico, o ranking e a
  // loja vão se pendurar.
  //
  // A presença é uma VARREDURA, e não um leitor de linha de log:
  // ela compara quem o servidor lista com quem a tabela diz estar
  // online. O relógio começa a bater no boot, e a primeira rodada é
  // o que fecha as sessões que ficaram abertas quando o agente
  // caiu — ver players/presence.ts.
  const playersRepository = new PlayersRepository(db);

  presence = new PresenceTracker({
    repository: playersRepository,
    reader: players,
    servers: supervisor,
    logger,
  });

  // As filas de entrega, uma por servidor pareado. O mapa nasce
  // aqui, VAZIO, porque o gancho de presença abaixo precisa dele —
  // e a fila só pode ser construída depois da loja, que é quem
  // entrega. O gancho consulta o mapa em tempo de execução.
  const siteDeliveries = new Map<string, SiteDeliveries>();
  const presenceWatcher = new PresenceWatcher({
    tracker: presence,
    logger,
    // O item pago é entregue no minuto em que o jogador abre o
    // inventário, e não até 15 s depois: a cabeça da fila é onde
    // moram as tarefas adiadas com PLAYER_OFFLINE, e acabou de
    // entrar uma das pessoas que faltavam.
    onJoined: (serverId) => siteDeliveries.get(serverId)?.wake(),
  });

  presenceWatcher.start();

  // A ficha e a listagem. O banimento dela é LIDO da BanList: uma
  // coluna `banned` aqui seria a segunda fonte para o mesmo fato.
  const directory = new PlayerDirectory({ repository: playersRepository, bans });

  // ---- o catálogo de itens e as interfaces -------------------
  //
  // ####  AS DUAS SOBREVIVEM AO SERVIDOR DESLIGADO  ####
  //
  // A lista de itens vem do jogo (`origemz.items`), mas mora no
  // banco: montar um kit é trabalho de madrugada, com tudo parado.
  // Ela é conferida na reconexão do RCON e só é relida quando o
  // PROTOCOLO do jogo muda — catálogo de item não envelhece com o
  // tempo, envelhece com a versão.
  //
  // A interface é o caminho contrário: o desenho mora aqui e
  // precisa ser EMPURRADO para o plugin, que guarda tudo em
  // memória. Um `oxide.reload` esvazia esse cache sem o agente
  // ficar sabendo — daí o relógio periódico e o pedido que o
  // próprio plugin faz.
  const itemsRepository = new ItemsRepository(db);

  itemCatalog = new ItemCatalog({
    repository: itemsRepository,
    servers: supervisor,
    logger,
  });

  // ---- o VIP, os loadouts e a loja de kits ------------------
  //
  // O agente é a FONTE dos três: o plugin guarda um cache
  // descartável, repovoado a cada sincronização. Se a fonte fosse o
  // jogo, um wipe ou um `oxide.reload` apagaria VIP comprado com
  // dinheiro.
  //
  // A reconciliação do boot NÃO segura a subida (`void`): ela fala
  // com N servidores pelo RCON, e a porta da API não pode esperar
  // por isso. Os que ainda não conectaram entram pelo gancho
  // `onRconConnected`, acima.
  const vipsRepository = new VipsRepository(db);
  const loadoutsRepository = new LoadoutsRepository(db);
  const spawnStatusRepository = new SpawnStatusRepository(db);
  const kitsRepository = new KitsRepository(db);

  // Ele só nasce lá embaixo, junto com os clientes do site — e a
  // `VipList` precisa existir ANTES deles. O closure resolve a
  // ordem: quem chama lê a variável na hora da chamada, e enquanto
  // ela for `null` o gancho não faz nada (o relógio do espelho
  // cobre, ver `VipListDeps.onChanged`).
  let vipSiteMirror: VipSiteMirror | null = null;

  vips = new VipList({
    repository: vipsRepository,
    servers: supervisor,
    logger,
    // "Ganhou VIP" vira uma linha na ficha do jogador — ver a
    // migração 014.
    history: directory,
    onChanged: () => vipSiteMirror?.notifyChanged(),
  });

  void vips.reconcileAll();

  // O relógio dos VIPs com prazo. Sem ele, `expires_at` seria
  // enfeite: a data passaria e o jogador continuaria com a tag, a
  // vaga na fila e o kit.
  const vipWatcher = new VipExpiryWatcher({ vips, logger });

  vipWatcher.start();

  loadoutSync = new LoadoutSync({
    repository: loadoutsRepository,
    servers: supervisor,
    logger,
  });

  spawnStatusSync = new SpawnStatusSync({
    repository: spawnStatusRepository,
    servers: supervisor,
    logger,
  });

  // ---- a loja e a carteira ---------------------------------
  //
  // ####  A CARTEIRA É ESCOLHIDA UMA VEZ, AQUI  ####
  //
  // Com `STORE_WALLET_URL` preenchido, quem manda no saldo é o site
  // externo; sem ele, o banco do agente. Ninguém mais neste processo
  // precisa saber qual das duas está no ar — as duas implementam a
  // mesma interface, e é isso que evita um `if` em cada ponto que
  // mexe em dinheiro.
  const storeRepository = new StoreRepository(db);
  const walletsRepository = new WalletsRepository(db);

  // ####  OS BEACONS NASCEM ANTES DAS CARTEIRAS  ####
  //
  // A carteira precisa avisá-los quando um débito volta com
  // `cause: 'pairing'`, e a ordem inversa deixaria o
  // `onPairingSuspect` sem ninguém para chamar. O mapa é declarado
  // aqui e preenchido logo abaixo, no mesmo laço que cria os
  // clientes: um pareamento, um cliente, um beacon.
  const siteBeacons = new Map<string, SiteBeacon>();
  // ####  A INTEGRAÇÃO COM O SITE É UM INTERRUPTOR SÓ  ####
  //
  // `SITE_BASE_URL` vazia: nada disto nasce, e o agente é o mesmo de
  // antes. Preenchida: cada servidor PAREADO ganha um cliente e uma
  // carteira próprios — o site modela um `Server` por linha de
  // `agents`, com um bearer cada, e um RustAgent administra N.
  //
  // Servidor sem pareamento continua na carteira LOCAL, e isso é uma
  // configuração legítima: um servidor novo entra no ar antes de
  // alguém cadastrá-lo lá.
  // ####  A URL DO SITE PODE VIR DO PAINEL  ####
  //
  // O `.env` é o padrão da instalação; a tela pode sobrescrevê-la,
  // e o valor vive na tabela `meta`. Ela NÃO reescreve o `.env` de
  // propósito: é lá que moram os segredos que trancam o operador
  // do lado de fora (`AGENT_API_TOKEN`, a senha do painel), e um
  // writer com defeito ali custa o acesso ao painel. Errar a URL
  // do site só deixa a loja indisponível.
  const meta = new MetaRepository(db);
  const siteBaseUrl = normalizeSiteBaseUrl(meta.read(SITE_BASE_URL_KEY) ?? agent.site.baseUrl);

  const siteClients = new Map<string, SiteClient>();
  const siteWallets = new Map<string, SiteWallet>();

  if (siteBaseUrl !== '') {
    for (const server of servers) {
      if (server.site === null) {
        logger.warn(
          { server: server.id },
          'server has no SITE_SERVER_ID: its store keeps using the LOCAL wallet',
        );
        continue;
      }

      const client = new SiteClient({
        baseUrl: siteBaseUrl,
        token: server.site.token,
        serverId: server.site.serverId,
        userAgent: agent.site.userAgent,
        timeoutMs: agent.site.timeoutMs,
        logger,
      });

      siteClients.set(server.id, client);
      siteBeacons.set(
        server.id,
        new SiteBeacon({
          client,
          token: server.site.token,
          port: agent.port,
          version: VERSION,
          mac: primaryMac(),
          logger,
          intervalMs: agent.site.beaconIntervalMs,
        }),
      );

      // ####  SEM TOKEN, O CLIENTE EXISTE E A CARTEIRA NÃO  ####
      //
      // É o primeiro degrau da virada, e ele PRECISA desta condição:
      // com o servidor cadastrado e o bearer ainda vazio, o cliente
      // existe (o beacon precisa dele, e é a única rota sem bearer),
      // mas a CARTEIRA continua local. Sem isso, todo débito sairia
      // sem `Authorization`, tomaria 401 `MISSING_BEARER` e a loja
      // in-game ficaria morta para todos os jogadores durante um
      // passo que existe justamente para não custar nada.
      if (!client.authenticated) {
        logger.warn(
          { server: server.id, siteServerId: server.site.serverId },
          'server is paired but SITE_TOKEN is empty: beaconing only, wallet stays LOCAL',
        );
        continue;
      }

      siteWallets.set(
        server.id,
        new SiteWallet({
          client,
          logger,
          // O beacon precisa saber AGORA que o pareamento quebrou: é
          // assim que o agente descobre em segundos, e não em
          // minutos, que o token foi rotacionado.
          onPairingSuspect: (reason) => siteBeacons.get(server.id)?.suspect(reason),
        }),
      );
    }
  }

  const localWallet = new LocalWallet(walletsRepository);
  /** A carteira DAQUELE servidor. Sem pareamento, a local. */
  const walletFor = (serverId: string): Wallet => siteWallets.get(serverId) ?? localWallet;
  // A carteira "principal" é só para as rotas que não têm servidor —
  // o extrato de um jogador, por exemplo. O saldo do site é global
  // por steamId, então qualquer pareamento responde o mesmo número;
  // o que muda é qual bearer pergunta.
  const wallet: Wallet = siteWallets.values().next().value ?? localWallet;

  logger.info(
    {
      source: wallet.source,
      site: siteBaseUrl === '' ? null : siteBaseUrl,
      paired: [...siteWallets.keys()],
    },
    wallet.source === 'local'
      ? 'a carteira é a LOCAL (o banco do agente)'
      : 'a carteira é a do SITE (o site externo é o dono do saldo)',
  );

  const store = new StoreService({
    repository: storeRepository,
    wallet,
    servers: supervisor,
    // O VIP comprado nasce pelo MESMO caminho do concedido no
    // painel: ele expira, aparece na lista e sincroniza com o
    // plugin. Um segundo caminho seria um VIP que nunca vence.
    vips,
    logger,
    history: directory,
    // A carteira DAQUELE servidor: o débito precisa sair com o
    // `X-Server-Id` de quem vendeu, ou o ledger do site atribui a
    // venda ao vizinho.
    walletFor,
    maxOzPerPurchase: agent.store.maxOzPerPurchase,
    // Sem pareamento a referência é o `purchaseId` cru — que é o
    // que a carteira LOCAL sempre gravou em `wallet_entries`.
    newReference: (serverId, purchaseId) => {
      const paired = servers.find((server) => server.id === serverId)?.site ?? null;

      return paired === null
        ? purchaseId
        : buildReference(paired.serverId, 'loja', purchaseId);
    },
    // ####  A LOJA SÓ COBRA COM O PAREAMENTO ATIVO  ####
    //
    // Servidor SEM pareamento está sempre pronto: ele usa a
    // carteira local, e a loja dele funciona como sempre. Quem
    // tem pareamento espera o beacon dizer `active` — enquanto
    // isso a loja responde INDISPONÍVEL, nunca "saldo 0".
    ready: (serverId) => siteBeacons.get(serverId)?.ready ?? true,
    proofFor: (serverId) => siteWallets.get(serverId) ?? null,
  });

  for (const beacon of siteBeacons.values()) {
    beacon.start();
  }

  // ####  O SETTLER NASCE ANTES DA VIRADA, E É DE PROPÓSITO  ####
  //
  // `charge-unknown` passa a ser produzido assim que a carteira do
  // site entra, e ele é o único desfecho que NÃO fecha a compra.
  // Sem o relógio, um timeout deixaria o jogador cobrado, sem
  // item, com a compra aberta e sem ninguém para resolvê-la.
  //
  // Ele não custa nada antes da virada: com a carteira local,
  // `unknown` nunca acontece, e a varredura roda sobre zero
  // linhas.
  const siteSettler =
    siteWallets.size === 0
      ? null
      : new PurchaseSettler({
          service: store,
          repository: storeRepository,
          logger,
          intervalMs: agent.site.settleIntervalMs,
        });

  siteSettler?.start();

  /**
   * Quem está conectado NAQUELE servidor.
   *
   * ####  `null` NÃO É LISTA VAZIA  ####
   *
   * `null` = não deu para PERGUNTAR (RCON fora, lista ilegível), e
   * lista vazia = perguntei e não tem ninguém. A fila de entregas
   * adia com motivos diferentes nos dois casos, e nada é tentado às
   * cegas.
   *
   * Ele NÃO é o `onlinePlayersOf` das mensagens: aquele devolve uma
   * CONTAGEM, e dois nomes parecidos com tipos diferentes no mesmo
   * arquivo é o começo de um bug de leitura.
   */
  const onlineSteamIdsOf = async (serverId: string): Promise<readonly string[] | null> => {
    const context = supervisor.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return null;
    }

    try {
      const worldSize = supervisor.configOf(serverId)?.worldSize ?? 0;
      const snapshot = await players.list(serverId, context.rcon, worldSize);

      return snapshot.players.map((player) => player.steamId);
    } catch {
      return null;
    }
  };

  // ####  A FILA DE ENTREGAS, UMA POR PAREAMENTO  ####
  //
  // Cada fila é escopada pelo `X-Server-Id` do bearer dela, então
  // ela já sabe onde entregar: no servidor local daquele
  // pareamento. É por isso que não existe uma variável dizendo
  // "qual servidor recebe" — a pergunta não existe com N
  // pareamentos.
  const siteDeliveriesRepository = new SiteDeliveriesRepository(db);

  for (const [id, client] of siteClients) {
    if (!siteWallets.has(id)) {
      // Sem token não há como puxar fila: a rota é autenticada.
      continue;
    }

    siteDeliveries.set(
      id,
      new SiteDeliveries({
        client,
        repository: siteDeliveriesRepository,
        serverId: id,
        presence: onlineSteamIdsOf,
        // O MESMO caminho da compra in-game, e não um segundo: um
        // ajuste que só um dos dois recebesse apareceria como
        // "às vezes o item vem sem skin".
        deliver: (input) => store.deliverPlan(input.serverId, input.steamId, input.plan),
        // Tirar VIP não é entregar, e por isso não passa pelo
        // `deliverPlan`: quem manda no VIP é a `VipList`, e é ela
        // que grava a revogação, tira o grupo de quem está no ar e
        // deixa a reconciliação cuidar de quem não está.
        revokeVip:
          vips === null
            ? undefined
            : async ({ steamId, tier }): Promise<void> => {
                // `revoked_by` é quem mandou tirar, e a ficha do
                // jogador mostra isso: aqui não foi um operador, foi
                // o site (estorno, chargeback, ban ou o prazo dele).
                await vips.revoke(steamId, tier, 'site');
              },
        logger,
        pollMs: agent.site.deliveryPollMs,
      }),
    );
  }

  for (const queue of siteDeliveries.values()) {
    queue.start();
  }

  // ####  UM CATÁLOGO, N DESTINOS  ####
  //
  // As tabelas da loja não têm `server_id`: a loja é UMA, e todos
  // os servidores mostram a mesma. O mesmo snapshot vai para cada
  // `Server` pareado, e cada um guarda a própria versão
  // confirmada.
  const catalogMirror =
    !agent.site.catalogPushEnabled || siteWallets.size === 0
      ? null
      : new CatalogMirror({
          clients: new Map(
            [...siteClients].filter(([id]) => siteWallets.has(id)),
          ),
          repository: storeRepository,
          meta,
          logger,
        });

  catalogMirror?.start();

  // ####  UM RETRATO DE VIP, N DESTINOS  ####
  //
  // Mesma forma do catálogo, e pelo mesmo motivo: a tabela `vips`
  // também não tem `server_id` — o VIP é do AGENTE e vale em todos
  // os servidores dele.
  //
  // O que muda é a direção do que se conta. O catálogo é uma
  // decisão nossa que o site exibe; o VIP é um estado com PRAZO que
  // o site vendeu e não tem como conferir. Ver vip/site-mirror.ts.
  vipSiteMirror =
    siteWallets.size === 0
      ? null
      : new VipSiteMirror({
          clients: new Map([...siteClients].filter(([id]) => siteWallets.has(id))),
          repository: vipsRepository,
          meta,
          // Quais níveis existem no jogo, para o cadastro do site
          // ESCOLHER em vez de digitar. A união dos servidores, que
          // é o que o `knownTiers` já monta: o VIP é do agente, e um
          // nível declarado em qualquer servidor dele é concedível.
          tiers: async (): Promise<readonly string[]> =>
            vips === null ? [] : [...(await vips.knownTiers()).keys()],
          logger,
        });

  vipSiteMirror?.start();

  // O que a tela de diagnóstico lê. Um mapa por servidor PAREADO:
  // "a loja parou" quase sempre é um servidor só, e uma resposta
  // agregada esconderia qual.
  const sitePairedServers = new Map<string, SitePairedServer>();

  for (const [id, beacon] of siteBeacons) {
    const paired = servers.find((server) => server.id === id)?.site ?? null;
    const siteWallet = siteWallets.get(id) ?? null;

    sitePairedServers.set(id, {
      beacon,
      siteServerId: paired?.serverId ?? '',
      hasToken: (paired?.token ?? '') !== '',
      walletHealth: siteWallet === null ? null : () => siteWallet.health,
    });
  }

  /**
   * A vitrine e os modais, montados do catálogo de AGORA.
   *
   * `nameOf` vem do catálogo de itens: a oferta guarda `rifle.ak`,
   * que é o que o jogo precisa para entregar, mas numa lista de kit
   * quem lê quer "Assault Rifle". Sem o catálogo lido, o recurso
   * final é o próprio shortname — feio, mas nunca vazio.
   */
  const storeScreens = createStoreScreenProvider({
    store,
    wallet,
    logger,
    nameOf: (shortname) => itemsRepository.get(shortname)?.displayName ?? shortname,
  });

  const uiDocuments = new UiDocumentsRepository(db, logger);

  // ####  O MENU PRINCIPAL NASCE NO PRIMEIRO BOOT  ####
  //
  // E só nele: a condição é a tabela estar VAZIA, não o slug estar
  // ausente. Recriá-lo por slug desfaria, a cada subida, quem o
  // tivesse apagado de propósito — e quem o editou perderia a
  // edição se trocasse o identificador.
  //
  // Ele nasce sem servidor nenhum ligado a ele: escolher o menu de
  // cada servidor é decisão de quem administra, em Configurações.
  if (uiDocuments.list().length === 0) {
    const seeded = uiDocuments.create(buildMainMenu());

    logger.info(
      { uiDocument: seeded.slug },
      'nenhuma interface no banco: o Menu Principal foi criado a partir do modelo',
    );
  }

  uiSync = new UiSync({
    repository: uiDocuments,
    servers: supervisor,
    logger,
    // ####  DUAS TELAS SÃO MONTADAS DO BANCO  ####
    //
    // A de KITS e a da LOJA têm endereço no documento e nenhum
    // conteúdo gravado: o que o admin cria no painel precisa
    // aparecer no jogo sem ninguém abrir o editor, e as duas
    // dependem de QUEM está pedindo — uma para saber se ele já
    // pegou, a outra para saber se ele pode pagar.
    //
    // A loja vem PRIMEIRO porque ela reconhece uma família de
    // endereços (`tela-loja:categoria:2`, `ozitem:id:3`), e a de
    // kits um id exato.
    generatedScreens: async (input) => {
      const fromStore = await storeScreens(input);

      if (fromStore !== null) {
        return fromStore;
      }

      const kitTarget = parseKitScreenId(input.screenId);

      if (kitTarget === null) {
        // ####  E, POR ÚLTIMO, O CALENDÁRIO  ####
        //
        // Ele reconhece um id EXATO (`tela-calendario`) e devolve
        // `null` para o resto — inclusive para as telas desenhadas
        // no editor, que seguem pelo caminho normal. Ele fica no
        // fim porque é o mais novo, e porque a agenda de onde ele
        // lê nasce depois do `UiSync` (ver a variável lá em cima).
        if (!isCalendarScreenId(input.screenId)) {
          return null;
        }

        // ####  O CALENDÁRIO NUNCA CAI NA TELA DO PRESET  ####
        //
        // A subida inteira é síncrona, então na prática o provedor
        // já está montado quando o primeiro pedido chega. Mas o
        // custo de estar errado é alto e silencioso: sem o provedor,
        // o `UiSync` serviria o retângulo DESENHADO ("Wipes e
        // eventos programados entram aqui"), que não é `volatile` —
        // o plugin o guarda e o servidor inteiro fica com ele por
        // até cinco minutos. A tela vazia daqui some no clique
        // seguinte.
        return (
          (await calendarScreens?.(input)) ??
          buildEmptyCalendarBundle(input.document, input.screenId)
        );
      }

      const offers = await kits.listForServer(input.serverId, input.steamId);

      return toGeneratedScreenBundle(
        input.document,
        buildKitsScreen({
          offers,
          target: kitTarget,
          screenId: input.screenId,
          // O ícone e o nome bonito vêm do catálogo: o kit guarda
          // `rifle.ak`, e o CUI desenha por `itemId`.
          itemOf: (shortname) => {
            const item = itemsRepository.get(shortname);

            return item === null ? null : { itemId: item.itemId, displayName: item.displayName };
          },
        }),
        // O SHELL conhece `tela-kits`; o modal de detalhes é filho
        // dela. Sem isto, abrir o "i" apagaria o destaque da aba.
        KITS_SCREEN_ID,
      );
    },
    // O clique de COMPRAR ou RESGATAR, já autenticado pelo segredo.
    // A frase que o jogador lê nasce em quem conhece a regra — "você
    // já pegou este kit", "saldo insuficiente" e "não deu para
    // entregar" são coisas diferentes.
    onBuy: createStoreBuyHandler({
      store,
      wallet,
      logger,
      // O `offerId` que não é de uma oferta pode ser o slug de um
      // kit: os dois entram pelo mesmo botão. Ver `fallback` em
      // game/ui-store-bridge.ts.
      fallback: async ({ serverId, steamId, offerId, document, screenId }) => {
        const kit = kits.list().find((entry) => entry.slug === offerId);

        if (kit === undefined) {
          return { ok: false, message: 'Este item não está mais na loja.' };
        }

        const result = await kits.claim({ kitId: kit.id, serverId, steamId, actor: 'menu' });
        const ok = result.status === 'entregue';

        const message = ok
          ? `${kit.name}: ${String(result.delivered)} de ${String(result.total)} item(ns) no seu inventário.`
          : (result.detail ?? 'Não deu para entregar o kit agora.');

        // O mesmo aviso da loja: um kit resgatado e uma compra
        // terminam do mesmo jeito na tela de quem clicou — e o OK
        // volta para a lista, que chega com o card já atualizado.
        return { ok, message, screen: buildResult(document, ok, message, null, screenId) };
      },
    }),
    // O saldo e o VIP do cabeçalho, para aquele jogador.
    //
    // O VIP vem do REPOSITÓRIO, e não do `VipList`: o serviço
    // devolve datas em ISO (é a forma da API), e o cabeçalho precisa
    // do epoch para calcular quantos dias faltam.
    onHeader: createHeaderProvider({ wallet, vips: vipsRepository, logger }),
    // ####  O SEGREDO SEPARA O CLIQUE DO CHAT  ####
    //
    // O agente lê o console inteiro, e o chat dos jogadores passa
    // por ele. Sem o segredo, alguém digitando o marcador pediria
    // um kit. Ele é sorteado A CADA SUBIDA: um segredo guardado em
    // disco vazaria junto com qualquer backup, e não há nada aqui
    // que precise sobreviver a um restart.
    secret: randomUUID(),
    // Lidas UMA vez, no boot: são bytes de PNG que não mudam
    // enquanto o processo vive, e relê-las a cada envio seria ler
    // disco para mandar o mesmo conteúdo.
    images: loadUiImages(agent.paths.root, logger),
  });

  uiSync.start();

  void loadoutSync.pushAll('boot');
  void spawnStatusSync.pushAll('boot');

  // A loja. Ela pergunta ao `PlayersReader` quem está online —
  // entrega exige o jogador dentro do servidor, porque item entra
  // em inventário e inventário só existe para quem está conectado.
  //
  // `null` = não deu para perguntar, e é DIFERENTE de lista vazia:
  // com `null` a entrega é recusada dizendo que não deu para
  // conferir, em vez de afirmar que o jogador está fora.
  const kits = new KitStore({
    repository: kitsRepository,
    vips: vipsRepository,
    servers: supervisor,
    presence: { online: onlineSteamIdsOf },
    logger,
    history: directory,
    // Quem responde "já passaram 2 h do wipe?". Sem resposta, o kit
    // libera: recusar sem certeza puniria o jogador por um servidor
    // que não respondeu.
    wipe: {
      at: (serverId) => wipeClock.at(serverId, supervisor.contextOf(serverId)?.rcon ?? null),
    },
  });

  // O vigia da Steam: compara o build instalado com o publicado e,
  // com STEAM_AUTO_UPDATE=1, dispara o ciclo de atualização
  // sozinho. Ele cede a vez ao SteamCMD sempre que há operação
  // rodando.
  const steamWatcher = new SteamUpdateWatcher({
    supervisor,
    paths: agent.paths,
    lock,
    logger,
    intervalMs: agent.steam.checkIntervalMs,
    // O padrão da máquina. A opinião POR SERVIDOR — a que o site
    // grava — mora na tabela `meta`, e é por isso que o vigia
    // precisa dela: sem persistir, o override sumiria no restart.
    autoUpdate: agent.steam.autoUpdate,
    meta,
  });

  steamWatcher.start();

  // ####  O RETRATO PERIÓDICO, UM POR PAREAMENTO  ####
  //
  // O terceiro relógio do site, no mesmo molde do beacon e da fila:
  // 30 s, uma batida no boot, e um erro de rede que não derruba
  // nada. Ele nasce AQUI, e não junto dos outros dois, por uma
  // razão de ordem: o retrato leva o build da Steam, e o
  // `steamWatcher` só existe a partir desta linha.
  //
  // ####  ELE É TELEMETRIA  ####
  //
  // Nenhum desfecho dele mexe em loja, carteira ou entrega. O único
  // efeito colateral é acordar o beacon quando o site responde que
  // o pareamento não vale — diagnóstico, não dinheiro.
  const siteStatuses = new Map<string, SiteStatus>();

  if (agent.site.statusPushEnabled) {
    for (const [id, client] of siteClients) {
      if (!siteWallets.has(id)) {
        // Sem token não há rota autenticada: o beacon continua, e o
        // retrato espera a ativação no admin do site.
        continue;
      }

      siteStatuses.set(
        id,
        new SiteStatus({
          client,
          serverId: id,
          version: VERSION,
          startedAt,
          logger,
          intervalMs: agent.site.statusIntervalMs,
          // A pasta pode ainda não existir (máquina nova, nenhum
          // servidor instalado). Aí a pergunta certa é sobre a raiz
          // do projeto, que existe sempre — igual à tela de sistema.
          disk: async () =>
            (await diskUsage(agent.paths.serversDir)) ?? (await diskUsage(agent.paths.root)),
          onPairingSuspect: (reason) => siteBeacons.get(id)?.suspect(reason),
          collect: async () => {
            // A varredura de processos tem cache de 3 s: chamá-la
            // aqui é o que faz `running` vir booleano em vez de
            // "ainda não sei".
            await supervisor.scanProcesses();

            const view = supervisor.view(id);

            if (view === null) {
              return null;
            }

            const context = supervisor.contextOf(id);
            let snapshot: PlayersSnapshot | null = null;

            if (context !== null && context.rcon.isConnected) {
              try {
                snapshot = await players.list(id, context.rcon, view.worldSize);
              } catch {
                // `null` = não deu para PERGUNTAR, e o retrato diz
                // isso com `source: 'unavailable'`. Uma lista vazia
                // aqui mostraria um servidor cheio como vazio.
                snapshot = null;
              }
            }

            const running =
              operations.list(id).find((operation) => operation.status === 'running') ?? null;

            return {
              server: view,
              players: snapshot,
              // O ÚLTIMO retrato guardado: `stateOf` NÃO fala com a
              // Steam. Um `check()` a cada 30 s disputaria o lock do
              // SteamCMD com um download de 6 GB.
              build: steamWatcher.stateOf(id),
              operation: running?.view() ?? null,
              kinds: supervisor.operationsOf(id).kinds(),
            };
          },
        }),
      );
    }
  }

  if (siteStatuses.size === 0 && siteWallets.size > 0) {
    // Com pareamento ativo e nenhum retrato, a pergunta "por que o
    // site não mostra meu servidor?" tem uma resposta só, e ela
    // precisa estar no log da subida.
    logger.warn(
      { paired: [...siteWallets.keys()] },
      'SITE_STATUS_PUSH_ENABLED=0: the site will not receive the periodic server status',
    );
  }

  for (const reporter of siteStatuses.values()) {
    reporter.start();
  }

  // ####  A FILA DE COMANDOS E A CONFIG DESEJADA  ####
  //
  // Os dois últimos relógios do site, e os únicos que MUDAM a
  // máquina: o admin clica "Reiniciar" no painel do site e o
  // servidor reinicia; ele grava o mapa lá e o `.ini` daqui passa a
  // ter esse valor.
  //
  // ####  NENHUM DOS DOIS ABRE CAMINHO NOVO  ####
  //
  // O comando vira uma `operation` normal, com a mesma trava por
  // recurso, o mesmo log e o mesmo `operationId` do painel local. A
  // config é gravada pelo MESMO `updateSettings` que o
  // `PATCH /api/servers/:id` usa. Uma segunda maneira de executar ou
  // de escrever o `.ini` é a última coisa que este canal pode criar.
  //
  // Eles nascem aqui, e não junto do beacon, pela mesma razão de
  // ordem do retrato: precisam do supervisor já montado.
  const siteCommandsRepository = new SiteCommandsRepository(db);
  const siteCommands = new Map<string, SiteCommands>();
  const siteConfigs = new Map<string, SiteConfig>();

  for (const [id, client] of siteClients) {
    if (!siteWallets.has(id)) {
      // Sem token não há rota autenticada: as duas são.
      continue;
    }

    if (agent.site.commandsEnabled) {
      siteCommands.set(
        id,
        new SiteCommands({
          client,
          repository: siteCommandsRepository,
          serverId: id,
          // `false` também quando o servidor sumiu do supervisor: o
          // agente não cuida dele, e é isso que o site precisa ouvir.
          enabled: () => supervisor.view(id)?.enabled === true,
          installed: () => supervisor.view(id)?.installed === true,
          execute: async (kind) => {
            // A varredura de processos antes do disparo: é ela que
            // faz as pré-condições saberem se o servidor está no ar.
            // Sem isso, um `server-start` num servidor já no ar
            // passaria pela recusa e subiria um segundo processo.
            await supervisor.scanProcesses();

            const operation = await supervisor.operationsOf(id).start({ kind });

            return {
              operationId: operation.id,
              done: operation.done.then((finished) => ({
                status: finished.status,
                message: finished.message,
              })),
            };
          },
          logger,
          pollMs: agent.site.commandPollMs,
        }),
      );
    }

    if (agent.site.configPullEnabled) {
      siteConfigs.set(
        id,
        new SiteConfig({
          client,
          meta,
          serverId: id,
          apply: (patch) => supervisor.updateSettings(id, patch),
          // Ligar/desligar não é gravar uma linha: é montar ou
          // desmontar o contexto e o RCON daquele servidor, e por
          // isso não cabe no `updateSettings`.
          //
          // O laço de config nasce do PAREAMENTO, e não do `enabled`:
          // um servidor desligado continua puxando config, e é isso
          // que permite ao site religá-lo depois.
          setEnabled: async (value) => {
            if (value) {
              supervisor.enable(id);
              return;
            }

            await supervisor.disable(id);
          },
          // A atualização automática não é campo do `.ini`: quem a
          // aplica é o vigia da Steam, e ele grava a escolha para
          // ela sobreviver ao restart. Passá-la no patch faria o
          // `updateSettings` ignorá-la em silêncio.
          setAutoUpdate: (value) => {
            steamWatcher.setAutoUpdate(id, value);
          },
          logger,
          intervalMs: agent.site.configIntervalMs,
        }),
      );
    }
  }

  for (const queue of siteCommands.values()) {
    queue.start();
  }

  for (const desired of siteConfigs.values()) {
    desired.start();
  }

  // ---- a config de REDE que vem do site ---------------------
  //
  // ####  UM LAÇO POR ASSUNTO, E UM CLIENTE SÓ  ####
  //
  // A loja não tem `server_id`: ela é UMA, e todos os servidores
  // mostram a mesma. Os kits são da rede, e o VIP é da conta do
  // jogador. Se este laço rodasse por pareamento, dois `Server` do
  // site poderiam mandar catálogos diferentes para o MESMO banco, e
  // o último a chegar ganharia — uma loja que muda sozinha a cada
  // minuto.
  //
  // Por isso ele fala por UM pareamento, escolhido de forma estável
  // (o primeiro id local em ordem). O site precisa responder o mesmo
  // conteúdo em qualquer `Server` deste agente.
  const siteDomainLoops: SiteDomainLoop[] = [];
  const domainOwner = [...siteClients]
    .filter(([id]) => siteWallets.has(id))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];

  if (agent.site.domainPullEnabled && domainOwner !== undefined) {
    const [ownerId, ownerClient] = domainOwner;
    const wanted =
      agent.site.domains.length === 0 ? [...SITE_DOMAINS] : agent.site.domains;
    // A fábrica existe pelo genérico: cada assunto tem uma forma de
    // `desired` própria, e é aqui que ela deixa de importar.
    const loopOf = <W,>(applier: DomainApplier<W>): SiteDomainLoop =>
      new SiteDomainConfig({
        client: ownerClient,
        meta,
        applier,
        logger,
        intervalMs: agent.site.domainIntervalMs,
      });
    const candidates: readonly SiteDomainLoop[] = [
      loopOf(
        storeApplier({
          repository: storeRepository,
          // O espelho precisa saber: sem isto, o catálogo que o
          // próprio site mandou só apareceria no painel dele na
          // volta seguinte do relógio.
          ...(catalogMirror === null ? {} : { onChanged: () => catalogMirror.notifyChanged() }),
        }),
      ),
      loopOf(
        kitsApplier({
          repository: kitsRepository,
          // O site conhece cada servidor pelo `SITE_SERVER_ID`, e o
          // retrato não manda o id local. A tradução mora na
          // fronteira, num lugar só.
          localServerId: (siteServerId) =>
            servers.find((server) => server.site?.serverId === siteServerId)?.id ?? null,
        }),
      ),
      loopOf(vipsApplier({ vips })),
    ];

    for (const loop of candidates) {
      if (wanted.includes(loop.domain)) {
        siteDomainLoops.push(loop);
      }
    }

    logger.warn(
      { server: ownerId, domains: siteDomainLoops.map((loop) => loop.domain) },
      'the site OWNS these subjects: its snapshot replaces what the local panel has',
    );
  }

  for (const loop of siteDomainLoops) {
    loop.start();
  }

  // ---- a agenda do wipe -------------------------------------
  //
  // ####  ELA É MATERIALIZADA, E O BOOT É QUEM MATERIALIZA  ####
  //
  // A agenda não é calculada na hora da pergunta: ela é uma tabela,
  // porque um wipe agendado é algo que se edita (adiar, pular,
  // trocar a política). O cálculo vira linha aqui e a cada
  // gravação da configuração pelo painel.
  //
  // Reconciliar NÃO regera: o que o admin editou fica, o passado
  // não é tocado, e os ids não mudam. Um servidor que falhe não
  // derruba os outros nem a subida — a agenda é informação, e a
  // porta da API vale mais que ela.
  //
  // Nada disto EXECUTA wipe: quem apaga arquivo é a operação
  // `wipe-run`, que ainda não existe. Ver Docs\16 §6.
  const wipeSchedule = new WipeScheduleRepository(db);

  for (const [serverId, result] of wipeSchedule.reconcileAll(supervisor.ids())) {
    if (result instanceof Error) {
      logger.error(
        { server: serverId, err: result },
        'não deu para materializar a agenda de wipe deste servidor',
      );
      continue;
    }

    if (result.created + result.updated + result.removed > 0) {
      logger.info({ server: serverId, ...result }, 'agenda de wipe materializada');
    }
  }

  // ---- as mensagens agendadas -------------------------------
  //
  // ####  UMA IMPLEMENTAÇÃO SÓ DE "FALAR NO CHAT"  ####
  //
  // O `PluginBroadcaster` é o transporte, e ele é ÚNICO: as
  // mensagens do admin, os avisos de wipe e o anúncio do mundo novo
  // passam todos por aqui. Três "mandar texto ao jogo" diferentes
  // dariam três formatos de aviso, três jeitos de tratar o RCON
  // caído e três lugares para consertar quando o plugin mudar de
  // comando. Ver Docs\17-FRENTES-WIPE-E-MENSAGENS.md §10.
  //
  // ####  E O REGISTRO DE VARIÁVEIS É O PONTO DE ENCONTRO  ####
  //
  // O módulo de mensagens NÃO pode saber o que é um wipe (Docs\16
  // §11). O núcleo registra `{servidor}`, `{online}` e `{max}`;
  // quem entende de `{wipe.*}` se registra aqui também, sem que
  // nada em `messages/` precise conhecer a agenda.
  /**
   * Quantos jogadores online naquele servidor.
   *
   * `null` = não deu para perguntar, e nunca zero: dizer "0
   * jogadores" num servidor cheio porque o RCON piscou faria a
   * mensagem `{online}` mentir E o "só com gente" calar uma
   * mensagem sem motivo.
   */
  const onlinePlayersOf = async (serverId: string): Promise<number | null> => {
    const context = supervisor.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return null;
    }

    try {
      const worldSize = supervisor.configOf(serverId)?.worldSize ?? 0;

      return (await players.list(serverId, context.rcon, worldSize)).players.length;
    } catch {
      return null;
    }
  };

  const messagesRepository = new MessagesRepository(db);
  const messageVariables = new VariableRegistry({ logger });

  registerCoreVariables(messageVariables, {
    // O que o jogador lê na lista da Steam, e não o id interno: a
    // frase sai no chat DELE.
    nameOf: (serverId) => supervisor.configOf(serverId)?.hostname ?? serverId,
    slotsOf: (serverId) => supervisor.configOf(serverId)?.maxPlayers ?? null,
    onlineOf: (serverId) => onlinePlayersOf(serverId),
  });

  const messages = new MessagesService({
    repository: messagesRepository,
    broadcaster: new PluginBroadcaster({ servers: supervisor, logger }),
    variables: messageVariables,
    servers: supervisor,
    // `null` = não deu para perguntar, e é DIFERENTE de zero: com
    // `null` a mensagem não sai e o horário não anda, porque não dá
    // para afirmar que o servidor está vazio.
    presence: { online: (serverId) => onlinePlayersOf(serverId) },
    logger,
  });

  messages.start();

  // ---- a prévia do mapa (RustMaps) --------------------------
  //
  // ####  A ÚNICA PEÇA DO AGENTE QUE PODE FALTAR SEM CONSEQUÊNCIA  ####
  //
  // Ela desenha a imagem do mundo que vem no próximo wipe. Sem
  // chave, sem rede ou com o site fora do ar, ela não faz nada — e
  // NADA muda: num mapa procedural a seed É o mapa, o terreno
  // nasce no boot e o wipe acontece igual. É por isso que o
  // relógio dela não bloqueia a subida, não segura desligamento
  // (`unref`) e nunca lança.
  //
  // A chave é lida do ambiente aqui, e não do `config.ts`, por um
  // motivo de convivência: nesta onda o `config.ts` está reservado
  // a outra frente (a chave SERVER_LEVELURL, Docs\17 §0.2), e uma
  // linha a mais lá seria conflito de merge num arquivo que já
  // está sendo editado. O `.env` já foi carregado pelo
  // `loadConfig()` lá em cima, então `process.env` aqui é o
  // arquivo. Quando a poeira assentar, isto vira um campo do
  // `AgentConfig` como os outros.
  const mapPool = new MapPoolRepository(db);

  // ####  EM QUE MUNDO CADA SERVIDOR ESTÁ, COM A MARCA DELE  ####
  //
  // Uma pergunta só depende disto: um wipe FORÇADO pode MANTER o
  // mundo de hoje? Não pode, quando ele é um `.map` custom sem a
  // marca de "compatível com a versão nova" — o forçado troca o
  // binário do jogo. Daqui ela vai para o chat e para a tela
  // CALENDÁRIO; as rotas do painel montam a delas em
  // http/server.ts e o executor monta a dele no `WipeRunner` —
  // todas com esta mesma função, que é o que garante uma resposta
  // só para "este mundo pode ficar?".
  const currentWorld = currentWorldReader({ servers: supervisor, mapPool });

  const rustmaps = new RustMapsWatcher({
    client: new RustMapsClient({ apiKey: process.env.RUSTMAPS_API_KEY ?? '' }),
    repository: mapPool,
    servers: supervisor,
    logger,
    autoGenerate: (process.env.RUSTMAPS_AUTO_GENERATE ?? '1').trim() !== '0',
  });

  rustmaps.start();

  // ####  A PÁGINA CALENDÁRIO DO MENU DO JOGO  ####
  //
  // Ela nasce AQUI, e não junto do `UiSync` lá em cima, porque
  // depende da agenda, da fila de mapas e das execuções em curso —
  // as três são construídas nesta parte do arquivo. Quem a chama é
  // o `generatedScreens`, que só corre quando um jogador clica em
  // CALENDÁRIO: a subida inteira é síncrona até o `app.listen`, e
  // nesse instante tudo aqui já existe. Se um dia deixar de ser, o
  // `generatedScreens` responde a tela vazia e VOLÁTIL em vez do
  // retângulo desenhado do preset — ver lá.
  //
  // O recorte por nível de VIP acontece DENTRO dela, antes de o
  // documento existir — o que o jogador não pode ver não atravessa
  // o RCON. Ver game/ui-calendar-screen.ts.
  const wipeRuns = new WipeRunsRepository(db);

  calendarScreens = createCalendarScreenProvider({
    schedule: wipeSchedule,
    // ####  ELA LÊ AS EXECUÇÕES, E NÃO SÓ A AGENDA  ####
    //
    // É o que o `{wipe.faltam}` do chat faz, e pelo mesmo motivo: o
    // "WIPAR AGORA com hora marcada" não tem plano, e nas horas
    // antes da hora marcada o plano está `running`. Sem isto a tela
    // anunciaria o wipe da semana que vem enquanto o chat conta as
    // horas do de hoje.
    runs: wipeRuns,
    mapPool,
    world: currentWorld,
    vips: vipsRepository,
    logger,
    levelsOf: async (serverId) => {
      const config = supervisor.configOf(serverId);

      return config === null ? [] : (await readVipTiers(config.paths.oxideConfigDir)).levels;
    },
  });

  // ---- os blueprints que sobrevivem ao wipe -----------------
  //
  // ####  ELE PRECISA NASCER ANTES DA EXECUÇÃO  ####
  //
  // A máquina de passos o chama em dois pontos: o snapshot, no
  // último instante em que o RCON ainda responde, e a fila de
  // devolução, depois de o mundo novo subir. Ver wipe/run.ts.
  //
  // O relógio dele é separado do relógio do wipe de propósito: a
  // devolução acontece HORAS depois (o `delayHours` da régua), e
  // com o jogador entrando — nada disso tem a ver com uma
  // execução em curso.
  const bpRepository = new BpRepository(db);

  const blueprints = new BlueprintService({
    repository: bpRepository,
    // O VIP da REDE, e a tabela — e não o cache do plugin: o
    // direito é conferido contra a fonte, no instante da entrega.
    vips: vipsRepository,
    servers: {
      ids: () => supervisor.ids(),
      rconOf: (serverId) => supervisor.contextOf(serverId)?.rcon ?? null,
    },
    // `null` = não deu para perguntar, e é DIFERENTE de "não há
    // ninguém": com `null` a rodada não entrega nada e tenta de
    // novo, em vez de concluir que o servidor está vazio.
    online: async (serverId) => {
      const context = supervisor.contextOf(serverId);

      if (context === null || !context.rcon.isConnected) {
        return null;
      }

      try {
        const worldSize = supervisor.configOf(serverId)?.worldSize ?? 0;
        const snapshot = await players.list(serverId, context.rcon, worldSize);

        return snapshot.players.map((player) => player.steamId);
      } catch {
        return null;
      }
    },
    logger,
  });

  blueprints.start();

  // ---- a EXECUÇÃO do wipe -----------------------------------
  //
  // ####  A LINHA DIVISÓRIA DO AGENTE  ####
  //
  // Tudo o que veio até aqui INFORMA. Daqui em diante ele APAGA
  // ARQUIVO: para o servidor, zipa o save, remove o mundo, escreve
  // a seed nova e sobe. Ver Docs\16 §15 — a etapa 5 é a que separa
  // as duas metades do sistema.
  //
  // (O `wipeRuns` em si é só LEITURA E ESCRITA de tabela, e por
  // isso ele nasce lá em cima, junto da fila de mapas: a página
  // CALENDÁRIO precisa dele para saber que há um wipe executando.)
  const detectedWipes = new WipesRepository(db);

  wipeRunner = new WipeRunner({
    runs: wipeRuns,
    wipes: detectedWipes,
    schedule: wipeSchedule,
    mapPool,
    servers: supervisor,
    world: {
      forget: (serverId) => {
        wipeClock.forget(serverId);
      },
      saveCreatedAt: (serverId) =>
        wipeClock.at(serverId, supervisor.contextOf(serverId)?.rcon ?? null),
    },
    // O MESMO transporte das mensagens agendadas. Ver o bloco delas,
    // acima: três maneiras de mandar texto ao jogo dariam três
    // formatos de aviso e três lugares para consertar.
    broadcaster: new PluginBroadcaster({ servers: supervisor, logger }),
    // ####  O LOCUTOR DOS AVISOS  ####
    //
    // As falas de "faltam 15 min". O relógio, a ordem dos offsets e
    // a marca do que já saiu continuam sendo do passo `avisar` (em
    // wipe/run.ts): o locutor só transforma UM offset numa fala, e
    // é isso que faz um aviso perdido não ter como derrubar o wipe.
    announcer: new WipeBroadcastAnnouncer({
      broadcaster: new PluginBroadcaster({ servers: supervisor, logger }),
      variables: messageVariables,
      logger,
    }),
    // O mundo novo sobe sem plugin sabendo de nada: o cache do
    // OrigemZ vive na memória do plugin, e o wipe derruba o RCON.
    // Isto repassa os estados completos — e é o mesmo caminho do
    // gancho `onRconConnected`, para não haver duas verdades sobre
    // "o que ressincronizar depois de subir".
    resync: async (serverId) => {
      await vips?.reconcile(serverId);
      await loadoutSync?.push(serverId, 'rcon-connected');
      await spawnStatusSync?.push(serverId, 'rcon-connected');
      uiSync?.pushSoon(serverId, 'rcon-connected');
    },
    logger,
    // A Frente I. Sem ela, `wipe_except_vip` se comportaria como
    // `wipe` — e o jogador que pagou recomeçaria sem nada.
    blueprints,
  });

  // ####  O QUE FICOU `running` DE UMA SESSÃO ANTERIOR  ####
  //
  // Uma execução cuja operação não existe mais (o agente reiniciou
  // no meio) vira `failed`, com a frase dizendo isso — e a tela
  // oferece retomar. Deixá-la `running` para sempre é a única saída
  // pior: ela bloquearia o próximo wipe pela trava por recurso, não
  // apareceria como problema em lugar nenhum, e não ofereceria
  // retomada.
  for (const orphan of wipeRuns.running()) {
    const alive = orphan.operationId !== null && operations.get(orphan.operationId) !== null;

    if (alive) {
      continue;
    }

    wipeRuns.orphan(orphan.serverId, orphan.id);

    logger.warn(
      { server: orphan.serverId, run: orphan.id },
      'execução de wipe interrompida por um reinício do agente; marcada como falha, e a tela ' +
        'oferece retomar',
    );
  }

  // ---- a ponte: `{wipe.*}` nas mensagens ---------------------
  //
  // ####  É AQUI QUE OS DOIS MÓDULOS SE ENCOSTAM, E SÓ AQUI  ####
  //
  // O módulo de mensagens não sabe o que é um wipe, e o módulo de
  // wipe não sabe mandar texto ao chat (Docs\16 §11). O que os liga
  // são duas interfaces pequenas: o `Broadcaster`, logo acima, e
  // este provedor. Nada em `messages/` importa `wipe/`.
  //
  // Depois desta linha, os DOIS caminhos que o pedido descreve
  // funcionam com a mesma conta: o aviso automático do passo
  // `avisar` e a mensagem editorial que o admin escreveu com
  // `{wipe.faltam}` dentro.
  registerWipeVariables(messageVariables, {
    schedule: wipeSchedule,
    runs: wipeRuns,
    mapPool,
    world: currentWorld,
  });

  // O relógio que dispara o plano vencido. Ele acorda de trinta em
  // trinta segundos e NUNCA lança: uma exceção sem dono mataria o
  // laço, e a partir dali nenhum wipe agendado aconteceria — em
  // silêncio. Ver wipe/scheduler.ts.
  const wipeScheduler = new WipeScheduler({
    schedule: wipeSchedule,
    runs: wipeRuns,
    servers: () => supervisor.ids(),
    launcher: {
      launch: async ({ serverId, planId }) => {
        const context = supervisor.contextOf(serverId);

        if (context === null) {
          throw new Error(
            `o agente não está cuidando do servidor "${serverId}" — o wipe agendado não pode ` +
              'começar sozinho',
          );
        }

        const plan = wipeSchedule.getPlan(serverId, planId);

        if (plan === null) {
          throw new Error(`o wipe agendado ${String(planId)} sumiu da agenda`);
        }

        const config = supervisor.configOf(serverId);
        const exec = wipeRuns.getExecSettings(serverId);

        const run = wipeRuns.create(serverId, {
          planId: plan.id,
          kind: plan.kind,
          bpPolicy: plan.bpPolicy,
          fullWipe: exec.pluginData.enabled,
          // O plano no PASSADO (o agente estava desligado na hora)
          // zera agora, e não numa data que já foi: esperar por um
          // instante que passou seria não zerar nunca.
          wipeAt: Math.max(plan.scheduledAt, Date.now()),
          mapBefore:
            config === null
              ? null
              : { level: config.level, seed: String(config.seed), worldSize: config.worldSize },
          saveCreatedBefore: await wipeClock.at(serverId, context.rcon),
        });

        await context.operations.start({ kind: 'wipe-run', wipe: { runId: run.id } });
        wipeSchedule.markPlanStatus(serverId, plan.id, 'running');
      },
    },
    logger,
  });

  wipeScheduler.start();

  // ---- 4. HTTP ---------------------------------------------
  const operators = new OperatorAuth({
    user: agent.panel.user,
    passwordHash: agent.panel.passwordHash,
    sessionTtlMs: agent.panel.sessionTtlMs,
  });

  if (!operators.configured) {
    logger.warn(
      'PANEL_PASSWORD_HASH está vazio: ninguém consegue entrar no painel. ' +
        'Gere uma senha com "npm run panel:senha -w core".',
    );
  }

  const app = buildServer({
    config: agent,
    logger,
    operators,
    version: VERSION,
    startedAt,
    supervisor,
    repository,
    operations,
    steamWatcher,
    library,
    bans,
    players,
    directory,
    monuments,
    items: itemsRepository,
    itemCatalog,
    uiDocuments,
    uiSync,
    vips,
    loadouts: {
      repository: loadoutsRepository,
      sync: loadoutSync,
      statusRepository: spawnStatusRepository,
      statusSync: spawnStatusSync,
    },
    kits: { store: kits, repository: kitsRepository },
    store: {
      repository: storeRepository,
      wallets: walletsRepository,
      service: store,
      wallet,
      // Uma edição de catálogo avisa o espelho. Sem site,
      // `undefined`, e as rotas não mudam de comportamento.
      ...(catalogMirror === null ? {} : { onCatalogChanged: () => catalogMirror.notifyChanged() }),
    },
    site: {
      baseUrl: siteBaseUrl,
      servers: sitePairedServers,
      // Lidos na HORA: é o estado do laço, e ele muda a cada volta.
      domains: () => siteDomainLoops.map((loop) => loop.health),
      // O `enabled` vem da configuração e o `status` do objeto: com
      // um só, a tela não separa "desligado" de "ligado mas sem
      // carteira nenhuma" — e as duas ausências pedem conserto
      // diferente.
      catalog: () => ({
        enabled: agent.site.catalogPushEnabled,
        status: catalogMirror?.status ?? null,
      }),
      // O espelho de VIP não tem chave de ligar/desligar: ele existe
      // sempre que há pareamento, porque o que ele conta é um estado
      // com PRAZO — desligá-lo seria deixar o site dizendo que gente
      // sem VIP tem VIP. Ver vip/site-mirror.ts.
      vipMirror: () => vipSiteMirror?.status ?? null,
      wallet,
      purchases: storeRepository,
      // De onde a URL veio, para a tela dizer se o que ela mostra é
      // o padrão da instalação ou algo que alguém digitou.
      // Lida na HORA, e não no boot: é ela que a tela edita.
      readSavedBaseUrl: () => meta.read(SITE_BASE_URL_KEY),
      envBaseUrl: agent.site.baseUrl,
      // O `.ini` de AGORA, e não o do boot: é a diferença entre os
      // dois que a tela precisa dizer em voz alta.
      savedPairings: () =>
        supervisor.ids().map((id) => {
          const paired = supervisor.configOf(id)?.site ?? null;

          return {
            serverId: id,
            siteServerId: paired?.serverId ?? '',
            hasToken: (paired?.token ?? '') !== '',
          };
        }),
      saveBaseUrl: (baseUrl) => {
        meta.write(SITE_BASE_URL_KEY, baseUrl);
      },
    },
    wipeRuns: {
      runs: wipeRuns,
      wipes: detectedWipes,
      world: {
        forget: (serverId) => {
          wipeClock.forget(serverId);
        },
        saveCreatedAt: (serverId) =>
          wipeClock.at(serverId, supervisor.contextOf(serverId)?.rcon ?? null),
      },
    },
    messages: {
      repository: messagesRepository,
      service: messages,
      variables: messageVariables,
    },
    servers: () =>
      supervisor.list().map((server) => ({
        id: server.id,
        enabled: server.enabled,
        rcon: server.rcon,
      })),
    wipeSchedule,

    // A fila de mapas do wipe. Nasce aqui, sem relógio e sem
    // laço: ela só responde perguntas do painel até a execução do
    // wipe passar a consumi-la.
    mapPool,

    // E o vigia que põe imagem nessa fila. Ver o bloco acima: ele
    // é a única peça do agente cuja ausência não muda nada.
    rustmaps,

    // A régua de blueprints, o snapshot e a devolução. O
    // repositório vai junto do serviço porque a tela lê o retrato
    // (quantos jogadores, quantos itens, quantos já receberam) sem
    // falar com o jogo.
    blueprints: { repository: bpRepository, service: blueprints },
  });

  await app.listen({ host: agent.host, port: agent.port });

  logger.info({ url: `http://${agent.host}:${String(agent.port)}` }, 'API no ar');

  if (agent.host !== '127.0.0.1') {
    logger.warn(
      { host: agent.host },
      'a API está EXPOSTA na rede. Quem a alcança instala, sobe e derruba os ' +
        'servidores desta máquina — ponha um proxy com TLS e restrinja no firewall.',
    );
  }

  // ---- desligamento ----------------------------------------
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ reason }, 'desligando');

    // O relógio de segurança: se algo travar no meio, o processo
    // sai mesmo assim. Sem isto, um socket que não fecha deixa o
    // PM2 esperando os 25 s dele para matar à força.
    const timer = setTimeout(() => {
      logger.error('desligamento não terminou a tempo — saindo à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    timer.unref();

    void (async () => {
      try {
        // Os relógios primeiro: uma rodada que começasse agora
        // falaria com um supervisor já parado.
        steamWatcher.stop();
        banWatcher.stop();
        presenceWatcher.stop();
        // O do estado dos plugins junto: uma leitura que começasse
        // agora falaria com um RCON que já não existe.
        oxideRuntime.stop();
        uiSync.stop();
        // O dos VIPs junto dos outros: um relógio esquecido aqui é
        // uma rodada que começa depois de o supervisor já ter
        // parado, falando com um RCON que não existe mais.
        vipWatcher.stop();
        // E o das mensagens junto dos outros, pela mesma razão: uma
        // volta que começasse agora falaria com um RCON que já não
        // existe.
        messages.stop();
        // O da prévia junto: ele não fala com o jogo, mas fala com
        // a internet, e uma resposta que chegasse depois do
        // `db.close()` gravaria num banco fechado.
        rustmaps.stop();
        // E o do wipe por último dos relógios, e pelo motivo mais
        // duro de todos: uma volta que começasse agora dispararia
        // uma operação que PARA O SERVIDOR — num agente que está
        // desligando, e que não estaria mais lá para subi-lo de
        // volta. Uma execução JÁ em curso não é interrompida aqui:
        // ela morre com o processo, e o boot seguinte a marca como
        // falha com a frase que oferece retomar.
        wipeScheduler.stop();
        // E o da devolução de blueprints junto dos outros: uma
        // rodada que começasse agora falaria com um RCON que já
        // não existe, e marcaria como entregue o que não saiu.
        blueprints.stop();
        // E os relógios do site, pela MESMA razão: uma batida ou
        // uma varredura que começasse agora falaria com um
        // supervisor já parado, e uma entrega decidida nesse
        // instante não teria por onde sair.
        for (const beacon of siteBeacons.values()) {
          beacon.stop();
        }

        siteSettler?.stop();

        for (const queue of siteDeliveries.values()) {
          queue.stop();
        }

        for (const reporter of siteStatuses.values()) {
          reporter.stop();
        }

        // Uma rodada de comandos que começasse agora disparia uma
        // operação sobre um supervisor a caminho do fim — e o
        // desfecho dela nunca chegaria ao site.
        for (const queue of siteCommands.values()) {
          queue.stop();
        }

        for (const desired of siteConfigs.values()) {
          desired.stop();
        }

        for (const loop of siteDomainLoops) {
          loop.stop();
        }

        catalogMirror?.stop();
        vipSiteMirror?.stop();
        await app.close();
        // Os contextos depois do HTTP: fechar o RCON com uma
        // requisição em voo faria a rota estourar em vez de
        // responder.
        await supervisor.stopAll();
        // O `close()` do better-sqlite3 faz o checkpoint do WAL.
        // Sem ele, o `-wal` cresce e o próximo boot paga a conta.
        db.close();
        logger.info('desligado');
        // Saída 0 = desligamento PEDIDO. O `stop_exit_codes: [0]`
        // do PM2 é o que impede o serviço de voltar em seguida.
        process.exit(0);
      } catch (error) {
        logger.error({ err: toError(error) }, 'falha no desligamento');
        process.exit(1);
      }
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // É por aqui que o desligamento chega no Windows. Ver o
  // cabeçalho.
  process.on('message', (message) => {
    if (message === 'shutdown') {
      shutdown('pm2 shutdown');
    }
  });
}

main().catch((error: unknown) => {
  console.error('[RustAgent] falha ao subir:', toError(error));
  process.exit(1);
});
