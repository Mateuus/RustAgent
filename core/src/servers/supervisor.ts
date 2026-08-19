// ============================================================
//  supervisor.ts  -  quem existe, quem está ligado, e como
//  ligar/desligar COM O AGENTE NO AR.
//
//  Sem este arquivo, criar um servidor pelo painel terminaria com
//  "agora reinicie o RustAgent" — e o servidor recém-criado nem
//  apareceria na lista até lá.
//
//  ------------------------------------------------------------
//  ####  DOIS CADASTROS, E UM SERVIDOR ESTÁ SEMPRE EM UM SÓ  ####
//
//    LIGADOS     têm `ServerContext`: RCON de pé, todas as
//                operações
//    DESLIGADOS  têm a configuração e um serviço de operações
//                RESTRITO — só `server-install`
//
//  O desligado precisa existir por um motivo prático: instalar É
//  a operação `server-install`, e um servidor recém-criado nasce
//  desligado justamente porque o jogo ainda não está em disco. Se
//  o desligado não tivesse nada, o único estado em que instalar
//  faz sentido seria o único em que a operação não existe.
//
//  ####  E POR QUE O DESLIGADO NÃO GANHA CONTEXTO  ####
//
//  Porque o `RconClient` reconecta para sempre, com recuo. Num
//  servidor sem jogo em disco isso é um socket batendo numa porta
//  onde nunca vai haver processo — e um painel mostrando "fora do
//  ar" um servidor que nunca esteve no ar.
//
//  ------------------------------------------------------------
//  ####  A ORDEM DO DESLIGAMENTO NÃO É ARBITRÁRIA  ####
//
//    1. o `.ini`      para o próximo boot concordar, mesmo que o
//                     agente morra no meio do resto
//    2. a tabela      o espelho que o painel lê
//    3. context.stop  fecha o RCON
//    4. tirar do mapa só depois de parado. Invertido, sobraria uma
//                     janela em que ninguém mais alcança o
//                     contexto para pará-lo — e ele continua vivo
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';

import { isInstalled, readServerConfig, type AgentPaths, type ServerConfig } from '../config.js';
import type { ServersRepository } from '../db/servers-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OperationLock, OperationStore } from '../ops/operations.js';
import { commandLineValue, listRustProcesses } from '../ops/server-process.js';
import { disconnectedRcon, OperationsService } from '../ops/service.js';
import { toError } from '../util.js';
import { ServerContext } from './context.js';
import type { WipeExecutor } from '../wipe/run.js';
import { applyIniValues } from './create-server.js';

export interface SupervisorDeps {
  readonly paths: AgentPaths;
  readonly store: OperationStore;
  readonly lock: OperationLock;
  readonly logger: Logger;
  readonly startTimeoutMs: number;
  readonly repository: ServersRepository;
  /**
   * Repassado a cada `ServerContext`. Ver `ServerContextDeps`.
   *
   * É o gancho da reconciliação da lista de banidos: ele dispara
   * quando o RCON daquele servidor conecta, que é o instante em
   * que os dois lados podem ter divergido sem ninguém ver.
   */
  readonly onRconConnected?: (serverId: string) => void;
  /**
   * Repassado a cada `ServerContext`. Ver `ServerContextDeps`.
   *
   * É por ele que o plugin da interface PEDE uma tela: o pedido
   * chega como uma linha do console, e este é o único lugar por
   * onde essas linhas passam.
   */
  readonly onConsoleLine?: (serverId: string, line: string) => void;
  /**
   * Repassado a cada `ServerContext`. Ver `ServerContextDeps`.
   *
   * É quem sabe executar um wipe. O supervisor não o usa: ele só o
   * entrega ao `OperationsService` de cada servidor, que é quem
   * empresta ao wipe os verbos de parar e subir.
   */
  readonly wipeRunner?: WipeExecutor;
}

/** O retrato de um servidor para a API. Ver Docs\06-API.md. */
export interface ServerView {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  readonly hostname: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  /** O jogo sobe com janela de console? Ver `ServerConfig`. */
  readonly consoleWindow: boolean;
  /**
   * O `RustDedicated.exe` daquele servidor está rodando NA
   * MÁQUINA?
   *
   * ####  ISTO É DIFERENTE DE `rcon.connected`  ####
   *
   * O processo pode estar no ar sem o agente cuidar dele — foi
   * exatamente o que aconteceu no primeiro teste desta versão: o
   * servidor rodando a 59% de CPU e o painel dizendo "parado",
   * porque a única coisa que a tela sabia era do RCON.
   *
   * `null` = ainda não varremos os processos (a varredura é
   * assíncrona e tem cache). Nunca `false` por omissão: "não sei"
   * e "não está rodando" são respostas diferentes.
   */
  readonly running: boolean | null;
  readonly pid: number | null;
  readonly map: string;
  readonly worldSize: number;
  readonly seed: number;
  readonly maxPlayers: number;
  readonly saveInterval: number;
  readonly description: string;
  readonly url: string;
  readonly headerImage: string;
  readonly steam: { appId: string; login: string; branch: string };
  readonly ports: { game: number; rcon: number; query: number; app: number };
  readonly rcon: { connected: boolean; state: string } | null;
  readonly paths: { installDir: string; configPath: string; logsDir: string };
}

/** Quanto tempo a varredura de processos vale. Ver `scanProcesses`. */
const PROCESS_SCAN_TTL_MS = 3_000;

export class ServerSupervisor {
  readonly #deps: SupervisorDeps;
  readonly #mounted = new Map<string, ServerContext>();
  readonly #unmounted = new Map<string, { config: ServerConfig; operations: OperationsService }>();

  /** id -> pid do RustDedicated, ou `null` se não achamos. */
  readonly #processes = new Map<string, number | null>();
  #scannedAt = 0;

  /**
   * A configuração MAIS RECENTE lida do disco, por servidor.
   *
   * O `ServerContext` guarda a de quando foi montado — e ela fica
   * velha no instante em que alguém edita o `.ini` pelo painel.
   * Sem este mapa, o PATCH gravava a mudança no arquivo e a
   * resposta devolvia o valor antigo: a tela mostrava o
   * interruptor voltando sozinho.
   */
  readonly #configs = new Map<string, ServerConfig>();

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
  }

  /**
   * O boot: reconcilia a tabela e monta quem está ligado.
   *
   * O `.ini` é a fonte da verdade e a tabela é o espelho (ver
   * Docs\02-ARQUITETURA.md) — por isso a reconciliação é sempre
   * do arquivo PARA o banco, nunca o contrário.
   */
  mountAll(configs: readonly ServerConfig[]): void {
    for (const config of configs) {
      this.#reconcile(config);
      this.#adopt(config);
    }

    this.#warnOrphans(configs);
  }

  /**
   * Linhas na tabela sem `.ini` correspondente.
   *
   * ####  ELAS NÃO SÃO APAGADAS, E ISSO É DELIBERADO  ####
   *
   * Um `.ini` renomeado por engano, ou movido durante uma
   * manutenção, faria o agente jogar fora a linha — e com ela, nas
   * fases seguintes, o histórico daquele servidor (entregas, VIP,
   * wipes) pelas chaves estrangeiras em cascata. Perder isso para
   * limpar uma tabela é um péssimo negócio.
   *
   * O que a órfã causa enquanto existe: `POST /api/servers` com
   * aquele id volta 409 `SERVER_ID_TAKEN` por causa de um servidor
   * que não aparece em lista nenhuma. Sem este aviso, isso é um
   * mistério; com ele, é uma linha no log dizendo o que houve e o
   * que fazer.
   */
  #warnOrphans(configs: readonly ServerConfig[]): void {
    const known = new Set(configs.map((config) => config.id));

    for (const record of this.#deps.repository.list()) {
      if (known.has(record.id)) {
        continue;
      }

      this.#deps.logger.warn(
        { server: record.id },
        `a tabela \`servers\` tem o id "${record.id}", mas Configs\\${record.id}.ini não ` +
          'existe mais. O agente NÃO cuida desse servidor e ele não aparece na lista — mas o ' +
          'id continua reservado (criar outro com o mesmo nome vai recusar). Restaure o .ini, ' +
          'ou escolha outro id.',
      );
    }
  }

  /** Um servidor recém-criado pelo painel entra por aqui. */
  adopt(config: ServerConfig): void {
    this.#reconcile(config);
    this.#adopt(config);
  }

  #adopt(config: ServerConfig): void {
    this.#configs.set(config.id, config);

    // Ligado E instalado -> contexto completo.
    if (config.enabled && isInstalled(config.paths)) {
      const context = new ServerContext(config, this.#deps);

      context.start();
      this.#mounted.set(config.id, context);
      this.#unmounted.delete(config.id);

      this.#deps.logger.info({ server: config.id }, 'servidor ligado');
      return;
    }

    if (config.enabled) {
      this.#deps.logger.warn(
        { server: config.id, exe: config.paths.exePath },
        'servidor marcado como ligado, mas o jogo não está instalado — ' +
          'ele fica só com a operação de instalar até o download terminar',
      );
    }

    this.#unmounted.set(config.id, {
      config,
      operations: new OperationsService({
        server: config,
        paths: this.#deps.paths,
        store: this.#deps.store,
        lock: this.#deps.lock,
        rcon: disconnectedRcon(config.id),
        logger: this.#deps.logger.child({ server: config.id }),
        startTimeoutMs: this.#deps.startTimeoutMs,
        // A trava que define o servidor desligado: sem RCON, um
        // `server-start` subiria um processo que o agente não
        // enxerga nem sabe derrubar.
        allowedKinds: ['server-install'],
        // E a saída dela: terminada a instalação, o agente adota o
        // servidor sozinho. Ver `onInstalled`, em ops/service.ts.
        onInstalled: () => {
          this.enable(config.id);
        },
      }),
    });

    this.#mounted.delete(config.id);
  }

  /** Copia o `.ini` para a tabela `servers`. */
  #reconcile(config: ServerConfig): void {
    const existing = this.#deps.repository.get(config.id);

    const fields = {
      name: config.name,
      identity: config.identity,
      enabled: config.enabled,
      gamePort: config.ports.game,
      rconPort: config.ports.rcon,
      queryPort: config.ports.query,
      appPort: config.ports.app,
      rconHost: config.rcon.host,
      installDir: config.paths.installDir,
    };

    try {
      if (existing === null) {
        this.#deps.repository.create({ id: config.id, ...fields });
      } else {
        this.#deps.repository.update(config.id, fields);
      }
    } catch (error) {
      // Reconciliar é ESPELHAR: uma falha aqui não pode impedir o
      // agente de cuidar do servidor, porque a verdade está no
      // arquivo. O que ela merece é um aviso alto — normalmente é
      // porta repetida com uma linha antiga.
      this.#deps.logger.warn(
        { server: config.id, err: toError(error) },
        'não consegui espelhar o servidor na tabela `servers`',
      );
    }
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  configOf(id: string): ServerConfig | null {
    // O mapa vem primeiro: ele tem o que o `.ini` diz AGORA. Ver
    // `#configs`.
    return (
      this.#configs.get(id) ??
      this.#mounted.get(id)?.config ??
      this.#unmounted.get(id)?.config ??
      null
    );
  }

  contextOf(id: string): ServerContext | null {
    return this.#mounted.get(id) ?? null;
  }

  /**
   * O serviço de operações daquele servidor.
   *
   * @throws {ApiError} 404 quando o id não existe.
   */
  operationsOf(id: string): OperationsService {
    const service = this.#mounted.get(id)?.operations ?? this.#unmounted.get(id)?.operations;

    if (service === undefined) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
          `${this.ids().join(', ') || '(nenhum)'}.`,
        404,
      );
    }

    return service;
  }

  ids(): readonly string[] {
    return [...this.#mounted.keys(), ...this.#unmounted.keys()].sort();
  }

  /**
   * Varre os processos da máquina e guarda o resultado.
   *
   * UMA varredura serve para TODOS os servidores: `wmic` custa
   * ~200 ms, e chamá-lo por servidor faria a lista de cinco
   * servidores levar um segundo. O cache curto (3 s) cobre o
   * polling do painel sem envelhecer a ponto de mentir.
   */
  async scanProcesses(): Promise<void> {
    if (Date.now() - this.#scannedAt < PROCESS_SCAN_TTL_MS) {
      return;
    }

    const processes = await listRustProcesses();

    this.#processes.clear();

    for (const id of this.ids()) {
      const config = this.configOf(id);

      if (config === null) {
        continue;
      }

      const found = processes.find((process) => {
        const identity = commandLineValue(process.commandLine, 'server\\.identity');
        const rconPort = commandLineValue(process.commandLine, 'rcon\\.port');

        return identity === config.identity || rconPort === String(config.ports.rcon);
      });

      this.#processes.set(id, found?.pid ?? null);
    }

    this.#scannedAt = Date.now();
  }

  list(): readonly ServerView[] {
    return this.ids()
      .map((id) => this.view(id))
      .filter((view): view is ServerView => view !== null);
  }

  view(id: string): ServerView | null {
    const context = this.#mounted.get(id);
    const config = this.configOf(id);

    if (config === null) {
      return null;
    }

    return {
      id: config.id,
      name: config.name,
      identity: config.identity,
      hostname: config.hostname,
      enabled: config.enabled,
      installed: isInstalled(config.paths),
      consoleWindow: config.consoleWindow,
      // `has` distingue "varremos e não achamos" (false) de "ainda
      // não varremos" (null). Ver o campo em `ServerView`.
      running: this.#processes.has(id) ? this.#processes.get(id) !== null : null,
      pid: this.#processes.get(id) ?? null,
      map: config.level,
      worldSize: config.worldSize,
      seed: config.seed,
      maxPlayers: config.maxPlayers,
      saveInterval: config.saveInterval,
      description: config.description,
      url: config.url,
      headerImage: config.headerImage,
      steam: { ...config.steam },
      ports: {
        game: config.ports.game,
        rcon: config.ports.rcon,
        query: config.ports.query,
        app: config.ports.app,
      },
      rcon: context?.status() ?? null,
      paths: {
        installDir: config.paths.installDir,
        configPath: config.paths.configPath,
        logsDir: config.paths.logsDir,
      },
    };
  }

  // ------------------------------------------------------
  //  Ligar e desligar
  // ------------------------------------------------------

  /**
   * Passa a cuidar do servidor: `.ini`, tabela, contexto, RCON.
   *
   * @throws {ApiError} 409 quando o jogo não está instalado — o
   * contexto nasceria reconectando para sempre.
   */
  enable(id: string): void {
    if (this.#mounted.has(id)) {
      return;
    }

    const entry = this.#unmounted.get(id);

    if (entry === undefined) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    if (!isInstalled(entry.config.paths)) {
      throw new ApiError(
        'SERVER_NOT_INSTALLED',
        `O jogo ainda não está em disco para o servidor "${id}" ` +
          `(${entry.config.paths.exePath} não existe). Instale primeiro — é a operação ` +
          'server-install, ou o botão Instalar no painel.',
        409,
      );
    }

    this.#writeEnabled(entry.config, true);

    // Reler o `.ini` em vez de mexer no objeto em memória: é o
    // arquivo que manda, e ele acabou de mudar.
    const config = readServerConfig(this.#deps.paths, id);

    this.#reconcile(config);
    this.#adopt(config);
  }

  /**
   * O que muda no `.ini` e SÓ vale no próximo start do jogo.
   *
   * O agente relê o arquivo antes de subir (ver `#start`, em
   * ops/service.ts), então a mudança não se perde — mas o mundo
   * que já está carregado não muda de mapa nem de seed. Dizer
   * isso é a diferença entre uma tela que engana e uma que
   * informa.
   */
  static readonly RESTART_KEYS = new Set([
    'hostname',
    'identity',
    'description',
    'url',
    'headerImage',
    'map',
    'seed',
    'worldSize',
    'maxPlayers',
    'saveInterval',
    'consoleWindow',
    'gamePort',
    'queryPort',
    'appPort',
    'rconPort',
    'rconPassword',
    'steamAppId',
    'steamLogin',
    'steamBranch',
    // Convar de mundo só é lida no BOOT: não existe trocar de
    // mapa a quente. Trocar o link do .map com o servidor no ar
    // não muda nada até ele parar e voltar — e é justamente isso
    // que a lista serve para dizer na tela.
    'levelUrl',
  ]);

  /**
   * Grava configuração no `.ini` daquele servidor.
   *
   * Recebe os campos com o nome que a API usa e traduz para as
   * chaves do arquivo — a tradução mora AQUI, num lugar só, e não
   * espalhada pelas rotas.
   *
   * @returns quais campos só valem depois de reiniciar o jogo.
   * @throws {ApiError}
   */
  updateSettings(id: string, patch: Readonly<Record<string, string | number | boolean>>): string[] {
    const config = this.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const KEY_OF: Readonly<Record<string, string>> = {
      name: 'SERVER_NAME',
      hostname: 'SERVER_HOSTNAME',
      identity: 'SERVER_IDENTITY',
      description: 'SERVER_DESCRIPTION',
      url: 'SERVER_URL',
      headerImage: 'SERVER_HEADERIMAGE',
      map: 'SERVER_LEVEL',
      seed: 'SERVER_SEED',
      worldSize: 'SERVER_WORLDSIZE',
      maxPlayers: 'SERVER_MAXPLAYERS',
      saveInterval: 'SERVER_SAVEINTERVAL',
      consoleWindow: 'SERVER_CONSOLE_WINDOW',
      gamePort: 'SERVER_PORT',
      queryPort: 'SERVER_QUERYPORT',
      appPort: 'SERVER_APPPORT',
      rconPort: 'RCON_PORT',
      rconPassword: 'RCON_PASSWORD',
      steamAppId: 'STEAM_APPID',
      steamLogin: 'STEAM_LOGIN',
      steamBranch: 'STEAM_BRANCH',
      // O mapa custom. Gravar vazio aqui é o jeito de VOLTAR ao
      // mundo procedural — a chave fica no arquivo, sem valor, e
      // a linha de comando volta a não ter `+server.levelurl`.
      levelUrl: 'SERVER_LEVELURL',
    };

    const values: Record<string, string> = {};
    const requiresRestart: string[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const key = KEY_OF[field];

      if (key === undefined) {
        continue;
      }

      values[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);

      if (ServerSupervisor.RESTART_KEYS.has(field)) {
        requiresRestart.push(field);
      }
    }

    if (Object.keys(values).length === 0) {
      return [];
    }

    this.#assertPortsFree(id, patch);
    this.#writeIni(config, values);

    // Reler é o que garante que a API devolve o que o ARQUIVO
    // diz, e não o que a requisição pediu — as duas coisas
    // divergem quando uma chave é recusada ou normalizada.
    const updated = readServerConfig(this.#deps.paths, id);

    this.#configs.set(id, updated);
    this.#reconcile(updated);

    if (!this.#mounted.has(id)) {
      this.#adopt(updated);
    }

    return requiresRestart;
  }

  /**
   * Porta pedida que já é de OUTRO servidor.
   *
   * A pergunta é ao cadastro, e não ao sistema operacional: o
   * conflito que importa aqui é com outro servidor DESTE agente —
   * o do SO é conferido na hora de subir, quando ele é definitivo.
   */
  #assertPortsFree(id: string, patch: Readonly<Record<string, string | number | boolean>>): void {
    const FIELD_OF: Readonly<Record<string, 'game' | 'query' | 'app' | 'rcon'>> = {
      gamePort: 'game',
      queryPort: 'query',
      appPort: 'app',
      rconPort: 'rcon',
    };

    for (const [field, kind] of Object.entries(FIELD_OF)) {
      const raw = patch[field];

      if (raw === undefined) {
        continue;
      }

      const port = Number(raw);

      for (const other of this.list()) {
        if (other.id === id) {
          continue;
        }

        const taken = Object.entries(other.ports).find(([, value]) => value === port);

        if (taken !== undefined) {
          throw new ApiError(
            'PORT_BLOCK_TAKEN',
            `A porta ${String(port)} (${kind}) já é do servidor "${other.id}" (${taken[0]}). ` +
              'Duas configurações com a mesma porta não sobem juntas — e o sintoma é o segundo ' +
              'servidor carregar o mundo inteiro e ficar sem aparecer na lista da Steam.',
            409,
          );
        }
      }
    }
  }

  /**
   * Liga ou desliga a janela de console do jogo.
   *
   * Vale no PRÓXIMO start: uma janela não aparece para um
   * processo que já está no ar, e derrubar o servidor para trocar
   * isso seria uma decisão de quem opera, não deste método.
   *
   * @throws {ApiError}
   */
  setConsoleWindow(id: string, value: boolean): void {
    const config = this.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    this.#writeIni(config, { SERVER_CONSOLE_WINDOW: value ? '1' : '0' });

    // Reler o `.ini` em vez de mexer no objeto em memória: é o
    // arquivo que manda.
    const updated = readServerConfig(this.#deps.paths, id);
    const mounted = this.#mounted.get(id);

    this.#configs.set(id, updated);

    if (mounted === undefined) {
      this.#adopt(updated);
      return;
    }

    // Servidor montado: trocar o contexto inteiro derrubaria o
    // RCON por causa de uma preferência de janela. O contexto
    // guarda a configuração de quando foi montado, e o `start`
    // seguinte lê o arquivo de novo — que é onde a mudança vale.
    this.#deps.logger.info(
      { server: id, consoleWindow: value },
      'janela de console do jogo alterada; vale no próximo start',
    );
  }

  /** Para de cuidar. A ordem está no cabeçalho deste arquivo. */
  async disable(id: string): Promise<void> {
    const context = this.#mounted.get(id);

    if (context === undefined) {
      return;
    }

    this.#writeEnabled(context.config, false);

    try {
      this.#deps.repository.update(id, { enabled: false });
    } catch (error) {
      this.#deps.logger.warn(
        { server: id, err: toError(error) },
        'não consegui espelhar o desligamento',
      );
    }

    await context.stop();

    const config = readServerConfig(this.#deps.paths, id);

    this.#adopt(config);
    this.#deps.logger.info({ server: id }, 'servidor desligado');
  }

  /**
   * Tira o servidor deste agente.
   *
   * NÃO apaga `Servers\<id>\`: dezenas de GB não somem por um
   * clique. Quem chama devolve na resposta onde a pasta ficou.
   */
  async forget(id: string): Promise<void> {
    await this.disable(id);
    this.#unmounted.delete(id);
    this.#mounted.delete(id);
    this.#configs.delete(id);
    this.#processes.delete(id);
  }

  /** O desligamento do agente inteiro. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#mounted.values()].map((context) => context.stop()));
    this.#mounted.clear();
  }

  /**
   * Grava chaves no `.ini` daquele servidor, preservando o resto.
   *
   * Pela mesma função que a criação usa (`applyIniValues`): uma
   * segunda implementação de "trocar uma chave do .ini" é a que
   * um dia apaga um comentário — ou a senha de RCON.
   */
  #writeIni(config: ServerConfig, values: Record<string, string>): void {
    const path = config.paths.configPath;

    try {
      const content = readFileSync(path, 'utf8');

      writeFileSync(path, applyIniValues(content, values), 'utf8');
    } catch (error) {
      throw new ApiError(
        'SERVER_CONFIG_WRITE_FAILED',
        `Não consegui escrever ${path}: ${toError(error).message}. A mudança NÃO foi ` +
          'aplicada — sem gravar o arquivo, o próximo boot a desfaria em silêncio.',
        500,
      );
    }
  }

  #writeEnabled(config: ServerConfig, enabled: boolean): void {
    this.#writeIni(config, { SERVER_ENABLED: enabled ? '1' : '0' });
  }
}
