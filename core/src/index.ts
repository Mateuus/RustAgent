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
import { MapImageKeeper } from './game/map-image.js';
import { MonumentReader } from './game/monuments.js';
import { PlayersReader } from './game/players.js';
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
import { LocalWallet, RemoteWallet, type Wallet } from './store/wallet.js';
import { toGeneratedScreenBundle } from './types/ui-transport.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { OperationLock, OperationStore } from './ops/operations.js';
import { PluginLibrary } from './oxide/library.js';
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

const VERSION = '1.0.0';

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
  const library = new PluginLibrary({
    libraryDir: agent.paths.pluginLibraryDir,
    repository: new PluginsRepository(db),
    servers: supervisor,
    logger,
  });

  void library.adoptAll();

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

  const presenceWatcher = new PresenceWatcher({ tracker: presence, logger });

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

  vips = new VipList({
    repository: vipsRepository,
    servers: supervisor,
    logger,
    // "Ganhou VIP" vira uma linha na ficha do jogador — ver a
    // migração 014.
    history: directory,
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

  const wallet: Wallet =
    agent.store.walletUrl === ''
      ? new LocalWallet(walletsRepository)
      : new RemoteWallet({
          baseUrl: agent.store.walletUrl,
          token: agent.store.walletToken,
          logger,
        });

  logger.info(
    { source: wallet.source, url: agent.store.walletUrl === '' ? null : agent.store.walletUrl },
    wallet.source === 'local'
      ? 'a carteira é a LOCAL (o banco do agente)'
      : 'a carteira é a REMOTA (o site externo é o dono do saldo)',
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
  });

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
    presence: {
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
    },
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
    autoUpdate: agent.steam.autoUpdate,
  });

  steamWatcher.start();

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
    store: { repository: storeRepository, wallets: walletsRepository, service: store, wallet },
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
