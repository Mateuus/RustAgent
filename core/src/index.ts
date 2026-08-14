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

import { OperatorAuth } from './auth/operator.js';
import { BanExpiryWatcher } from './bans/expiry-watcher.js';
import { BanList } from './bans/service.js';
import { ConfigError, loadConfig } from './config.js';
import { BansRepository } from './db/bans-repository.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { PluginsRepository } from './db/plugins-repository.js';
import { ServersRepository } from './db/servers-repository.js';
import { MapImageKeeper } from './game/map-image.js';
import { PlayersReader } from './game/players.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { OperationLock, OperationStore } from './ops/operations.js';
import { PluginLibrary } from './oxide/library.js';
import { ServerSupervisor } from './servers/supervisor.js';
import { SteamUpdateWatcher } from './steam/update-watcher.js';
import { toError } from './util.js';

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
    servers: () =>
      supervisor.list().map((server) => ({
        id: server.id,
        enabled: server.enabled,
        rcon: server.rcon,
      })),
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
