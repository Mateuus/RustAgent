// ============================================================
//  service.ts  -  QUEM SABE FAZER cada operação.
//
//  O `operations.ts` guarda estado; este arquivo executa. Um
//  serviço por servidor, criado pelo `ServerContext` (servidor
//  ligado) ou pelo supervisor em modo restrito (servidor
//  desligado, só a instalação).
//
//  ------------------------------------------------------------
//  ####  O POST RESPONDE 202, E O TRABALHO CONTINUA  ####
//
//  `start()` valida as pré-condições, pega a trava e devolve a
//  operação. O trabalho roda depois, escrevendo no log dela.
//
//  As recusas — servidor no ar, RCON fora, SteamCMD ocupado —
//  acontecem ANTES do 202, e por isso viram 409 na resposta do
//  próprio POST. Uma instalação de 6 GB não cabe em requisição
//  HTTP nenhuma, mas "não dá para instalar agora" cabe.
//
//  ------------------------------------------------------------
//  ####  "SUBIU" É O RCON RESPONDER  ####
//
//  Não é o processo existir. Um mapa procedural de 4000 leva
//  minutos para gerar, e o processo está lá o tempo todo sem
//  aceitar ninguém. Enquanto o RCON não responde, o estado é
//  "iniciando" — e a tela mostra o tempo decorrido, senão parece
//  travado e alguém clica em Iniciar de novo.
// ============================================================

import { existsSync } from 'node:fs';

import { readServerConfig, type AgentPaths, type ServerConfig } from '../config.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { installOxide } from '../oxide/install.js';
import {
  appManifestPath,
  isFullyInstalled,
  queryRemoteBuild,
  readInstalledBuild,
  type InstalledBuild,
} from '../steam/builds.js';
import { appUpdate, steamCmdExe } from '../steam/steamcmd.js';
import { toError } from '../util.js';
import { openOperationLogFile } from './op-log-file.js';
import {
  Operation,
  type OperationKind,
  type OperationLock,
  type OperationStore,
} from './operations.js';
import { findServerProcess, killServerProcess, startServer } from './server-process.js';
import type { WipeExecutor, WipeServerControl } from '../wipe/run.js';

/**
 * O que o serviço precisa do RCON.
 *
 * Interface mínima de propósito: um servidor DESLIGADO não tem
 * `RconClient` nenhum, e recebe a implementação `disconnectedRcon`
 * abaixo. Assim a instalação — a única operação que faz sentido
 * ali — funciona sem contexto.
 */
export interface OpsRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

export function disconnectedRcon(serverId: string): OpsRcon {
  return {
    isConnected: false,
    send: () =>
      Promise.reject(
        new ApiError(
          'RCON_UNAVAILABLE',
          `O agente não está conectado ao RCON do servidor "${serverId}".`,
          503,
        ),
      ),
  };
}

export interface StartOperationInput {
  readonly kind: OperationKind;
  /** Parar/atualizar mesmo sem RCON, matando o processo. */
  readonly force?: boolean;
  /** Minutos de aviso antes do `server-auto-update`. */
  readonly countdownMinutes?: number;
  /**
   * O build que a Steam publicou, quando quem pediu já sabe.
   *
   * É a régua da conferência do fim: o SteamCMD tem que ter
   * deixado ESTE build em disco. Sem ele, a conferência pergunta à
   * Steam na hora — o vigia passa porque acabou de perguntar.
   */
  readonly expectedBuild?: string;
  /**
   * A execução de wipe que esta operação vai tocar.
   *
   * ####  ELA É O QUE PROVA QUE A CHAMADA VEIO DA ROTA CERTA  ####
   *
   * `POST /operations` aceita qualquer `kind` do `OPERATION_KINDS`,
   * e não tem como exigir a `Idempotency-Key` nem o `identity`
   * digitado que o wipe exige (Docs\16 §8). Então a pré-condição
   * de `wipe-run` é a presença deste campo: quem o preenche é
   * `POST /wipe/runs`, que já conferiu as duas coisas e já abriu a
   * linha em `wipe_runs`.
   */
  readonly wipe?: {
    readonly runId: number;
    /** Retomada: os passos já concluídos não rodam de novo. */
    readonly resume?: boolean;
  };
}

export interface OperationsServiceOptions {
  readonly server: ServerConfig;
  readonly paths: AgentPaths;
  readonly store: OperationStore;
  readonly lock: OperationLock;
  readonly rcon: OpsRcon;
  readonly logger: Logger;
  /** Quanto esperar o RCON responder depois de subir. */
  readonly startTimeoutMs: number;
  /**
   * As operações permitidas.
   *
   * Um servidor DESLIGADO recebe `['server-install']` e nada
   * mais: sem RCON, um `server-start` subiria um processo que o
   * agente não enxerga nem sabe derrubar.
   */
  readonly allowedKinds?: readonly OperationKind[];

  /**
   * Chamado quando a instalação TERMINA BEM.
   *
   * ####  DEPOIS DE INSTALAR, CUIDAR É AUTOMÁTICO  ####
   *
   * "Cuidar" (o `SERVER_ENABLED`) existe por um motivo técnico:
   * montar o cliente RCON de um servidor sem jogo em disco produz
   * um socket reconectando para sempre numa porta onde nunca vai
   * haver processo. Esse motivo vale ATÉ a instalação terminar —
   * e some no instante em que ela termina.
   *
   * Deixar o passo na mão do operador era expor uma restrição
   * nossa como se fosse decisão dele: ninguém instala um servidor
   * para NÃO cuidar dele. Agora o agente adota sozinho, e o botão
   * de parar de cuidar continua existindo para o caso raro
   * (manutenção com o agente fora do caminho).
   */
  readonly onInstalled?: () => void;

  /**
   * Quem sabe executar um wipe. Ausente = este agente não wipa.
   *
   * A máquina de passos mora em wipe/run.ts, e não aqui, porque o
   * que ela precisa (a agenda, a fila de mapas, o backup, o
   * Broadcaster) não tem nada a ver com o que este serviço faz. O
   * que ela precisa DESTE arquivo são quatro verbos — parar,
   * subir, saber se está no ar, contar quem está online —, e eles
   * vão no `WipeServerControl` montado em `#wipeRun`.
   */
  readonly wipeRunner?: WipeExecutor;
}

/** Os marcos do aviso de atualização, em segundos. */
const COUNTDOWN_MARKS = [900, 600, 300, 180, 120, 60, 30, 10];

export const DEFAULT_COUNTDOWN_MINUTES = 15;
export const MAX_COUNTDOWN_MINUTES = 120;

export class OperationsService {
  readonly #options: OperationsServiceOptions;

  constructor(options: OperationsServiceOptions) {
    this.#options = options;
  }

  get serverId(): string {
    return this.#options.server.id;
  }

  /** O jogo está em disco? */
  get installed(): boolean {
    return existsSync(this.#options.server.paths.exePath);
  }

  /**
   * O processo do jogo está de pé?
   *
   * Público porque quem monta a prévia do wipe precisa da resposta
   * ANTES de qualquer coisa acontecer, e a pergunta é a mesma que
   * as pré-condições daqui já fazem. Uma segunda maneira de
   * procurar o processo divergiria da primeira no dia em que a
   * linha de comando mudasse.
   */
  async isRunning(): Promise<boolean> {
    return (await this.#processInfo()) !== null;
  }

  /**
   * O que este servidor aceita AGORA.
   *
   * É daqui que o painel desenha os botões — a tela não adivinha
   * e não esconde nada por conta própria (ver Docs\07-PAINEL.md).
   */
  kinds(): readonly OperationKind[] {
    const allowed = this.#options.allowedKinds;

    if (allowed !== undefined) {
      return allowed;
    }

    if (!this.installed) {
      // Sem jogo em disco só existe um caminho, e é o que a tela
      // precisa oferecer em letras grandes.
      return ['server-install'];
    }

    return [
      'server-install',
      'server-update',
      'server-start',
      'server-stop',
      'server-restart',
      'server-auto-update',
      'oxide-install',
      // No fim, e é a última da lista de propósito: ela é a única
      // que apaga o trabalho dos jogadores. A tela de Operações não
      // desenha botão para ela (o `ACTIONS` do painel não a tem);
      // quem a dispara é a sub-aba Execução do wipe.
      'wipe-run',
    ];
  }

  /**
   * Dispara a operação.
   *
   * @throws {ApiError} em toda recusa de pré-condição. Elas
   * acontecem aqui, antes do 202 — depois dele, o que sai é log.
   */
  async start(input: StartOperationInput): Promise<Operation> {
    const { kind } = input;

    if (!this.kinds().includes(kind)) {
      throw new ApiError(
        'OPERATION_NOT_ALLOWED',
        `A operação "${kind}" não vale para o servidor "${this.serverId}" no estado atual. ` +
          `O que dá para fazer agora: ${this.kinds().join(', ')}.`,
        409,
      );
    }

    const running = await this.#processInfo();

    // ---- as recusas, por operação ----
    const touchesDisk =
      kind === 'server-install' || kind === 'server-update' || kind === 'oxide-install';

    if (touchesDisk && running !== null) {
      throw new ApiError(
        'SERVER_RUNNING',
        `O servidor "${this.serverId}" está no ar (PID ${String(running.pid)}). O SteamCMD e ` +
          'o Oxide reescrevem arquivos que o processo mantém abertos — pare o servidor antes, ' +
          'ou use "Atualizar avisando", que derruba e sobe sozinha.',
        409,
      );
    }

    if (kind === 'server-start' && running !== null) {
      throw new ApiError(
        'SERVER_ALREADY_RUNNING',
        `O servidor "${this.serverId}" já está no ar (PID ${String(running.pid)}).`,
        409,
      );
    }

    if ((kind === 'server-stop' || kind === 'server-restart') && running === null) {
      throw new ApiError(
        'SERVER_NOT_RUNNING',
        `O servidor "${this.serverId}" não está no ar — não há o que parar.`,
        409,
      );
    }

    if (
      kind === 'server-stop' &&
      running !== null &&
      !this.#options.rcon.isConnected &&
      input.force !== true
    ) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `O processo do servidor "${this.serverId}" está no ar, mas o RCON não responde. ` +
          'Sem RCON não dá para encerrar salvando o mundo. Mande de novo com force=true para ' +
          'MATAR o processo — e aí se perde tudo desde o último save automático.',
        503,
      );
    }

    // ####  AS DUAS RECUSAS DO WIPE  ####
    //
    // A primeira é a que impede `POST /operations {kind:'wipe-run'}`
    // de zerar um servidor: aquela rota não tem como exigir o
    // `identity` digitado nem a `Idempotency-Key`, e as duas são
    // obrigatórias (Docs\16 §8). Quem preenche `input.wipe` é
    // `POST /wipe/runs`, depois de conferir as duas e de abrir a
    // linha em `wipe_runs`.
    if (kind === 'wipe-run') {
      if (this.#options.wipeRunner === undefined) {
        throw new ApiError(
          'WIPE_NOT_AVAILABLE',
          `Este agente não sabe executar wipe no servidor "${this.serverId}".`,
          409,
        );
      }

      if (input.wipe === undefined) {
        throw new ApiError(
          'WIPE_MUST_BE_CONFIRMED',
          'Um wipe não começa por esta rota. Ele apaga o trabalho de todos os jogadores, e por ' +
            'isso exige a confirmação pelo identity do servidor e uma Idempotency-Key — as duas ' +
            'em POST /api/servers/<id>/wipe/runs.',
          409,
        );
      }
    }

    const operation = new Operation(kind, this.serverId);
    const resources = resourcesFor(kind, this.serverId);

    // ####  O QUE ACONTECE AQUI FICA GRAVADO  ####
    //
    // O console da tela é ao vivo e some no `pm2 restart`, e a
    // saída do SteamCMD nunca passou pelo log do agente. Quem
    // precisasse explicar uma atualização automática que falhou
    // de madrugada não tinha o que ler. Agora tem — e a primeira
    // linha da operação diz onde.
    const file = openOperationLogFile(operation, {
      logsDir: this.#options.server.paths.logsDir,
      logger: this.#options.logger,
    });

    if (file !== null) {
      operation.pipeTo(file.sink);
      operation.log(`[agente] o log desta operação também vai para ${file.path}`);
    }

    // A trava vem por último, depois de todas as recusas: pegá-la
    // antes faria uma requisição inválida bloquear o SteamCMD até
    // o `release` do `finally`.
    this.#options.lock.acquire(resources, operation);
    this.#options.store.add(operation);

    void this.#execute(operation, input)
      .then(() => {
        if (operation.status === 'running') {
          operation.finish(operation.cancelled ? 'cancelled' : 'succeeded', null);
        }
      })
      .catch((error: unknown) => {
        const message = toError(error).message;

        operation.log(`[erro] ${message}`);
        operation.finish(operation.cancelled ? 'cancelled' : 'failed', message);

        this.#options.logger.error(
          { server: this.serverId, operation: operation.id, kind, err: toError(error) },
          'operação falhou',
        );
      })
      .finally(() => {
        this.#options.lock.release(resources);
      });

    return operation;
  }

  // ------------------------------------------------------
  //  A execução
  // ------------------------------------------------------

  async #execute(operation: Operation, input: StartOperationInput): Promise<void> {
    switch (operation.kind) {
      case 'server-install':
      case 'server-update':
        await this.#install(operation);
        return;

      case 'oxide-install':
        await this.#oxide(operation);
        return;

      case 'server-start':
        await this.#start(operation);
        return;

      case 'server-stop':
        await this.#stop(operation, input.force === true);
        return;

      case 'server-restart':
        await this.#stop(operation, input.force === true);
        await this.#start(operation);
        return;

      case 'server-auto-update':
        await this.#autoUpdate(operation, input);
        return;

      case 'wipe-run':
        await this.#wipeRun(operation, input);
        return;
    }
  }

  /**
   * O wipe. Este arquivo não sabe o que é um wipe — ele só empresta
   * os verbos.
   *
   * ####  POR QUE O CONTROLE É PASSADO, E NÃO A TRAVA REPETIDA  ####
   *
   * A máquina de passos precisa parar e subir o servidor no meio da
   * execução. Chamar `this.start({ kind: 'server-stop' })` daqui
   * esbarraria na trava de `server:<id>` que ESTA MESMA operação
   * acabou de pegar — a operação se recusaria a si mesma. Então ela
   * recebe os quatro verbos direto, já dentro da trava, e o que
   * sobe e desce continua sendo o código único de `#stop`/`#start`.
   */
  async #wipeRun(operation: Operation, input: StartOperationInput): Promise<void> {
    const runner = this.#options.wipeRunner;
    const wipe = input.wipe;

    if (runner === undefined || wipe === undefined) {
      // As duas recusas já aconteceram em `start()`, antes do 202.
      // Este guarda existe para o compilador, e para o dia em que
      // alguém chamar `#execute` de outro lugar.
      throw new Error('esta operação de wipe chegou aqui sem a execução que ela deveria tocar');
    }

    // Guardado numa variável porque o `get` abaixo não enxerga o
    // `this` da classe. O objeto é o mesmo, e `isConnected` nele é
    // vivo: o valor lido é sempre o de agora, e não o do momento em
    // que o wipe começou — que pode ter sido horas antes.
    const rcon = this.#options.rcon;

    const control: WipeServerControl = {
      isRunning: async () => (await this.#processInfo()) !== null,
      stop: (force) => this.#stop(operation, force),
      start: () => this.#start(operation),
      online: () => this.#onlinePlayers(),
      get rconConnected() {
        return rcon.isConnected;
      },
    };

    await runner.run({
      serverId: this.serverId,
      runId: wipe.runId,
      operation,
      control,
      resume: wipe.resume === true,
    });
  }

  /** SteamCMD + Oxide. É a operação que INSTALA e a que ATUALIZA. */
  async #install(operation: Operation, expectedBuild?: string | null): Promise<void> {
    const { server, paths } = this.#options;

    const before = await readInstalledBuild(server.paths.installDir, server.steam.appId);

    await appUpdate({
      dir: paths.steamCmdDir,
      installDir: server.paths.installDir,
      appId: server.steam.appId,
      login: server.steam.login,
      branch: server.steam.branch,
      onLine: (line) => operation.log(line),
      onProgress: (percent) => {
        operation.progress = percent;
      },
      signal: operation.signal,
    });

    await this.#verifyInstall(operation, before, expectedBuild ?? null);

    operation.progress = 100;
    operation.log('[agente] jogo instalado. Aplicando o Oxide por cima...');

    await this.#oxide(operation);

    // A partir daqui o servidor TEM jogo em disco, e o motivo de o
    // agente não cuidar dele deixou de existir. Ver `onInstalled`.
    if (this.#options.onInstalled !== undefined) {
      try {
        this.#options.onInstalled();
        operation.log('[agente] o agente passou a cuidar deste servidor. Pode iniciar.');
      } catch (error) {
        // Adotar é conveniência: falhar aqui não invalida a
        // instalação, que é o que a operação prometeu fazer.
        operation.log(
          `[agente] instalado, mas não consegui passar a cuidar dele: ${toError(error).message}`,
        );
      }
    }
  }

  /**
   * O SteamCMD terminou. Terminou BEM?
   *
   * ------------------------------------------------------------
   * ####  O EXECUTÁVEL EM DISCO SÓ RESPONDE À PRIMEIRA VEZ  ####
   *
   * Esta conferência começou olhando só o `RustDedicated.exe`, e
   * isso basta para uma instalação nova. Numa ATUALIZAÇÃO o
   * arquivo já está lá desde antes — então um job que morreu no
   * meio passava por aqui inteiro, o Oxide era aplicado, o
   * servidor subia e o painel dizia "jogo instalado" com o build
   * velho. Um servidor de build velho recusa TODOS os jogadores,
   * e ninguém descobre olhando a tela.
   *
   * O que responde à pergunta é o BUILDID no manifest, comparado
   * com o publicado. Quando quem chamou já sabe o publicado (o
   * vigia da Steam sabe), ele passa em `expected` e a gente
   * economiza os ~4 s da consulta.
   *
   * ####  NÃO CONSEGUIR PERGUNTAR NÃO É REPROVAR  ####
   *
   * Com a Steam fora do ar, a consulta falha — e falhar a
   * conferência aqui reprovaria uma atualização que pode ter dado
   * certo. Nesse caso fica o registro no log, e o que já foi
   * verificado (exe, manifest, arquivos inteiros) continua
   * valendo.
   */
  async #verifyInstall(
    operation: Operation,
    before: InstalledBuild | null,
    expected: string | null,
  ): Promise<void> {
    const { server } = this.#options;

    if (!existsSync(server.paths.exePath)) {
      throw new Error(
        `o SteamCMD terminou, mas ${server.paths.exePath} não existe. A instalação NÃO ` +
          'está boa — veja as últimas linhas do log acima.',
      );
    }

    const after = await readInstalledBuild(server.paths.installDir, server.steam.appId);

    if (after === null) {
      throw new Error(
        `o SteamCMD terminou, mas ${appManifestPath(server.paths.installDir, server.steam.appId)} ` +
          'não existe ou não tem buildid. Sem o manifest não dá para afirmar o que está em ' +
          'disco — trate como instalação incompleta e rode a operação de novo.',
      );
    }

    if (!isFullyInstalled(after)) {
      throw new Error(
        `o manifest diz que a instalação está incompleta (StateFlags ${String(after.stateFlags)}). ` +
          'Faltam arquivos ou o download parou no meio — rode a operação de novo.',
      );
    }

    const published = expected ?? (await this.#publishedBuild(operation));

    if (published !== null && after.buildId !== published) {
      throw new Error(
        `o SteamCMD terminou, mas o build em disco continua ${after.buildId} e o publicado é ` +
          `${published}. A ATUALIZAÇÃO NÃO FOI APLICADA — um servidor de build velho recusa ` +
          'todos os jogadores, então isto é falha e não aviso. Veja as linhas do SteamCMD acima.',
      );
    }

    operation.log(
      before === null
        ? `[agente] build ${after.buildId} instalado.`
        : before.buildId === after.buildId
          ? `[agente] build ${after.buildId} — já era o que estava em disco.`
          : `[agente] build ${before.buildId} -> ${after.buildId}.`,
    );
  }

  /** O build publicado, para conferir. `null` quando não deu para perguntar. */
  async #publishedBuild(operation: Operation): Promise<string | null> {
    const { server, paths } = this.#options;

    try {
      const build = await queryRemoteBuild({
        steamCmdExe: steamCmdExe(paths.steamCmdDir),
        appId: server.steam.appId,
        login: server.steam.login,
        branch: server.steam.branch,
        timeoutMs: 60_000,
        logger: this.#options.logger,
      });

      return build.buildId;
    } catch (error) {
      operation.log(
        `[agente] não deu para confirmar o build publicado (${toError(error).message}) — ` +
          'sigo com o que está em disco.',
      );

      return null;
    }
  }

  async #oxide(operation: Operation): Promise<void> {
    const { server } = this.#options;

    const result = await installOxide({
      installDir: server.paths.installDir,
      backupsDir: server.paths.backupsDir,
      onLine: (line) => operation.log(line),
      signal: operation.signal,
    });

    operation.log(`[agente] Oxide ${result.tag} pronto.`);
  }

  /** Sobe o processo e espera o RCON responder. */
  async #start(operation: Operation): Promise<void> {
    // ####  A CONFIGURAÇÃO É RELIDA AQUI  ####
    //
    // O contexto guarda o `.ini` de quando foi montado, e entre
    // aquele instante e este alguém pode ter mudado o mapa, a
    // seed ou a janela de console — pelo painel ou no editor. É
    // ESTE start que precisa refletir o arquivo, senão a mudança
    // só valeria depois de reiniciar o agente, e ninguém liga uma
    // coisa à outra.
    //
    // Falha na leitura cai para a configuração em memória: subir
    // com o que temos é melhor que não subir.
    let server = this.#options.server;

    try {
      server = readServerConfig(this.#options.paths, server.id);
    } catch (error) {
      operation.log(
        `[agente] não consegui reler ${server.paths.configPath} (${toError(error).message}); ` +
          'subindo com a configuração que já estava carregada.',
      );
    }

    const started = await startServer({
      server,
      onLine: (line) => operation.log(line),
    });

    operation.log(`[agente] processo no ar (PID ${String(started.pid)}). Esperando o RCON...`);

    const deadline = Date.now() + this.#options.startTimeoutMs;

    while (Date.now() < deadline) {
      if (operation.cancelled) {
        operation.log('[agente] espera cancelada — o servidor CONTINUA subindo.');
        return;
      }

      if (this.#options.rcon.isConnected) {
        const seconds = Math.round((Date.now() - operation.startedAt) / 1000);

        operation.log(`[agente] o RCON respondeu. Servidor no ar em ${String(seconds)}s.`);
        return;
      }

      await delay(3_000, operation.signal);
    }

    // O tempo esgotar NÃO derruba o servidor: gerar um mapa
    // grande pode passar do orçamento, e matar o processo aqui
    // jogaria fora minutos de trabalho por causa de um relógio.
    throw new Error(
      'o processo subiu, mas o RCON não respondeu em ' +
        `${String(Math.round(this.#options.startTimeoutMs / 60_000))} min. O servidor CONTINUA ` +
        'no ar — pode ser um mapa grande ainda gerando. Veja o log do jogo em ' +
        `${this.#options.server.paths.logsDir}.`,
    );
  }

  /** `server.save` + `quit` pelo RCON. `force` mata o processo. */
  async #stop(operation: Operation, force: boolean): Promise<void> {
    const info = await this.#processInfo();

    if (info === null) {
      operation.log('[agente] o servidor já estava parado.');
      return;
    }

    if (this.#options.rcon.isConnected) {
      operation.log('[agente] salvando o mundo (server.save)...');

      try {
        await this.#options.rcon.send('server.save');
      } catch (error) {
        operation.log(`[agente] o save falhou: ${toError(error).message}`);
      }

      operation.log('[agente] encerrando pelo RCON (quit)...');

      try {
        await this.#options.rcon.send('quit');
      } catch {
        // `quit` costuma derrubar a conexão antes de responder —
        // um erro aqui é o desfecho NORMAL, não uma falha.
        operation.log('[agente] a conexão caiu junto com o quit (é o esperado).');
      }
    } else if (!force) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        'O RCON não responde e force não foi pedido — não dá para encerrar salvando.',
        503,
      );
    }

    // Dois minutos: é quanto o Rust leva para gravar o mundo e
    // fechar. Menos que isso mataria um servidor que estava
    // salvando.
    const deadline = Date.now() + 120_000;

    while (Date.now() < deadline) {
      if ((await this.#processInfo()) === null) {
        operation.log('[agente] servidor parado.');
        return;
      }

      await delay(2_000, operation.signal);
    }

    if (!force) {
      throw new Error(
        'o servidor não encerrou em 2 minutos depois do quit. Mande de novo com force=true ' +
          'para matar o processo — o que se perde é tudo desde o último save automático.',
      );
    }

    operation.log(`[agente] matando o processo à força (PID ${String(info.pid)})...`);
    await killServerProcess(info.pid);
    operation.log('[agente] processo morto. O mundo desde o último save foi perdido.');
  }

  /**
   * O ciclo inteiro: avisa, conta, salva, encerra, atualiza, sobe.
   *
   * É a operação que o vigia da Steam dispara sozinho quando a
   * Facepunch publica um build novo (Etapa 6).
   */
  async #autoUpdate(operation: Operation, input: StartOperationInput): Promise<void> {
    const running = (await this.#processInfo()) !== null;

    if (running && this.#options.rcon.isConnected) {
      const minutes = clampCountdown(input.countdownMinutes ?? DEFAULT_COUNTDOWN_MINUTES);

      await this.#countdown(operation, minutes);

      if (operation.cancelled) {
        await this.#say(
          operation,
          'A atualizacao foi adiada. Ninguem sera desconectado agora. Bom jogo!',
        );
        return;
      }
    }

    if (running) {
      await this.#stop(operation, input.force === true);
    } else {
      operation.log('[agente] o servidor já estava parado — indo direto para a atualização.');
    }

    try {
      await this.#install(operation, input.expectedBuild ?? null);
    } catch (error) {
      // ####  FALHOU ATUALIZANDO ≠ FICAR FORA DO AR  ####
      //
      // O servidor foi derrubado por NÓS. Deixá-lo parado
      // trocaria "desatualizado" por "sumiu", e o segundo é pior:
      // some da lista, e quem olha o Discord conclui que o
      // servidor acabou. Ele volta com o build velho, a operação
      // consta como FALHA e o painel mostra o motivo.
      operation.log(`[agente] a atualização falhou: ${toError(error).message}`);

      if (running) {
        operation.log('[agente] subindo o servidor de volta para não deixá-lo fora do ar...');

        try {
          await this.#start(operation);
        } catch (startError) {
          operation.log(
            `[agente] e ainda não consegui subir de volta: ${toError(startError).message}`,
          );
        }
      }

      throw error;
    }

    await this.#start(operation);
  }

  /**
   * Os avisos no chat, nos marcos.
   *
   * Servidor vazio encurta para um minuto: contar quinze minutos
   * para ninguém é adiar a atualização à toa.
   */
  async #countdown(operation: Operation, minutes: number): Promise<void> {
    const empty = (await this.#onlinePlayers()) === 0;
    const totalSeconds = empty ? 60 : minutes * 60;

    if (empty) {
      operation.log('[agente] ninguém online — a contagem cai para 1 minuto.');
    }

    await this.#say(
      operation,
      `ATUALIZACAO DO RUST: o servidor vai reiniciar em ${String(Math.round(totalSeconds / 60))} ` +
        'minuto(s) para aplicar a atualizacao da Facepunch. Guardem o que puderem.',
    );

    const endsAt = Date.now() + totalSeconds * 1000;

    for (const mark of COUNTDOWN_MARKS) {
      if (mark >= totalSeconds) {
        continue;
      }

      const waitMs = endsAt - mark * 1000 - Date.now();

      if (waitMs > 0) {
        await delay(waitMs, operation.signal);
      }

      if (operation.cancelled) {
        return;
      }

      await this.#say(operation, `Reinicio para atualizacao em ${formatRemaining(mark)}.`);
    }

    const rest = endsAt - Date.now();

    if (rest > 0) {
      await delay(rest, operation.signal);
    }
  }

  async #say(operation: Operation, text: string): Promise<void> {
    // Aspas e rich text fora: o `say` do Rust quebra com aspas no
    // meio, e `<color>` deixaria qualquer integração se passar
    // por mensagem de admin.
    const clean = text.replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();

    operation.log(`[chat] ${clean}`);

    try {
      await this.#options.rcon.send(`say "${clean}"`);
    } catch (error) {
      operation.log(`[chat] não consegui avisar: ${toError(error).message}`);
    }
  }

  /**
   * Quantos jogadores online, pelo `playerlist` NATIVO do Rust.
   *
   * Nativo de propósito: a Fase 1 não depende de plugin nenhum
   * (ver Docs\04-PLANO-DE-MIGRACAO.md). `null` quando não dá para
   * saber — e aí a contagem usa o tempo cheio, que é o lado
   * seguro.
   */
  async #onlinePlayers(): Promise<number | null> {
    if (!this.#options.rcon.isConnected) {
      return null;
    }

    try {
      const response = await this.#options.rcon.send('playerlist');
      const parsed = JSON.parse(response) as unknown;

      return Array.isArray(parsed) ? parsed.length : null;
    } catch {
      return null;
    }
  }

  async #processInfo(): ReturnType<typeof findServerProcess> {
    return findServerProcess(this.#options.server);
  }
}

/** Que recursos cada operação disputa. Ver `OperationLock`. */
export function resourcesFor(kind: OperationKind, serverId: string): readonly string[] {
  switch (kind) {
    case 'server-install':
    case 'server-update':
    case 'server-auto-update':
      return ['steamcmd', `disk:${serverId}`, `server:${serverId}`];

    case 'oxide-install':
      return [`disk:${serverId}`, `server:${serverId}`];

    case 'server-start':
    case 'server-stop':
    case 'server-restart':
      return [`server:${serverId}`];

    // O wipe para, escreve em disco e sobe: ele disputa os dois. E
    // NÃO disputa o `steamcmd` — atualizar o jogo antes do wipe
    // forçado é uma operação à parte, disparada antes desta.
    case 'wipe-run':
      return [`disk:${serverId}`, `server:${serverId}`];
  }
}

export function clampCountdown(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return DEFAULT_COUNTDOWN_MINUTES;
  }

  return Math.max(0, Math.min(MAX_COUNTDOWN_MINUTES, Math.round(minutes)));
}

export function formatRemaining(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);

    return `${String(minutes)} minuto${minutes === 1 ? '' : 's'}`;
  }

  return `${String(seconds)} segundos`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
