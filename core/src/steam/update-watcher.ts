// ============================================================
//  update-watcher.ts  -  "o Rust atualizou. E agora?"
//
//  Quando a Facepunch publica uma atualização, o cliente do
//  jogador atualiza sozinho pela Steam e passa a falar um
//  protocolo que o servidor velho não entende. O servidor não
//  fica lento: ele RECUSA TODO MUNDO. Um servidor desatualizado é
//  um servidor vazio, e normalmente quem descobre primeiro é o
//  Discord.
//
//  ------------------------------------------------------------
//  ####  COMO ELE PERCEBE  ####
//
//    instalado   Servers\<id>\steamapps\appmanifest_258550.acf
//                o buildid que o SteamCMD gravou no fim do último
//                download
//
//    publicado   steamcmd +app_info_print 258550
//                o buildid do branch, direto do catálogo
//
//  A consulta leva ~4 s, NÃO baixa nada e é segura com o servidor
//  no ar. Ela CEDE A VEZ quando há operação rodando:
//  `app_info_print` e `app_update` disputam o mesmo lock do
//  SteamCMD, e a rotina não pode derrubar um download de 6 GB.
//
//  > Por que não usar o `Protocol` do `serverinfo`: ele exige o
//  > servidor NO AR — e é justamente com ele parado que mais
//  > interessa saber se há update pendente. E as correções
//  > semanais mudam o build sem mudar o protocolo: o servidor
//  > ficaria desatualizado em silêncio.
//
//  ------------------------------------------------------------
//  ####  AS TRÊS TRAVAS  ####
//
//  1. TRÊS TENTATIVAS POR BUILD, uma hora entre elas. Um update
//     que falha deixa o build velho instalado, e a rodada
//     seguinte veria a MESMA diferença — sem a trava, o servidor
//     seria derrubado a cada 15 minutos, para sempre.
//
//  2. INSTALAÇÃO INEXISTENTE NÃO É "ATUALIZAÇÃO". Numa máquina
//     onde o jogo ainda não foi baixado, `updateAvailable` é
//     false. Instalar pela primeira vez é decisão de quem monta,
//     não algo a disparar sozinho de madrugada.
//
//  3. FALHAR EM PERGUNTAR ≠ ESTAR EM DIA. Uma consulta que não
//     foi vira `lastError`, e a tela mostra isso em vermelho em
//     vez de afirmar que está tudo certo.
// ============================================================

import { existsSync } from 'node:fs';

import type { AgentPaths } from '../config.js';
import type { Logger } from '../logger.js';
import type { Operation, OperationLock } from '../ops/operations.js';
import type { ServerSupervisor } from '../servers/supervisor.js';
import { toError } from '../util.js';
import { pickBranch, queryRemoteBuilds, readInstalledBuild } from './builds.js';
import { steamCmdExe } from './steamcmd.js';

/** Quantas vezes tentar atualizar para o MESMO build. */
const MAX_ATTEMPTS_PER_BUILD = 3;

/** Espera entre tentativas do mesmo build. */
const RETRY_INTERVAL_MS = 60 * 60_000;

/** Teto da consulta ao catálogo. Ela costuma levar ~4 s. */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * O desfecho da última atualização que o VIGIA disparou.
 *
 * Sem isto, a tela só sabia que havia update publicado e repetia
 * "o agente atualiza sozinho" — a mesma frase depois de acertar,
 * depois de falhar uma vez e depois de desistir do build. Quem
 * olhava não tinha como distinguir "vai acontecer" de "já
 * aconteceu três vezes e deu errado".
 */
export interface AutoUpdateAttempt {
  readonly operationId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** O motivo, quando falhou. */
  readonly message: string | null;
}

export interface SteamUpdateState {
  readonly appId: string;
  readonly branch: string;
  /** `null` = o jogo não está em disco. */
  readonly installed: string | null;
  /** `null` = ainda não perguntamos, ou a consulta falhou. */
  readonly published: string | null;
  readonly updateAvailable: boolean;
  readonly checkedAt: number | null;
  readonly lastError: string | null;
  readonly autoUpdate: boolean;
  /** Tentativas gastas com o build publicado atual. */
  readonly attempts: number;
  /** Quantas cabem, ao todo, no mesmo build. */
  readonly maxAttempts: number;
  /** Como terminou a última delas. `null` = nenhuma ainda. */
  readonly lastAttempt: AutoUpdateAttempt | null;
  /** Quando sai a próxima, quando há uma marcada. Epoch ms. */
  readonly nextAttemptAt: number | null;
}

interface MutableState {
  installed: string | null;
  published: string | null;
  checkedAt: number | null;
  lastError: string | null;
  /** O build para o qual as tentativas abaixo foram gastas. */
  attemptsFor: string | null;
  attempts: number;
  lastAttemptAt: number | null;
  lastAttempt: AutoUpdateAttempt | null;
}

export interface UpdateWatcherOptions {
  readonly supervisor: ServerSupervisor;
  readonly paths: AgentPaths;
  readonly lock: OperationLock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly autoUpdate: boolean;
  /** Quanto esperar, depois do boot, pela PRIMEIRA conferência. */
  readonly firstCheckDelayMs?: number;
}

/**
 * Quanto o vigia espera antes da primeira conferência.
 *
 * ####  A ATUALIZAÇÃO NÃO ESPERA O RELÓGIO DAR A VOLTA  ####
 *
 * A primeira rodada saía só depois do intervalo inteiro — quinze
 * minutos em que um servidor recém-ligado pode estar
 * desatualizado e recusando todo mundo, com o painel ainda sem
 * nada a mostrar (nem o build instalado, nem o publicado). Um
 * minuto é o bastante para o agente terminar de subir, montar os
 * contextos e conectar os RCONs; a conferência não baixa nada e
 * cede a vez a qualquer operação em curso.
 */
const DEFAULT_FIRST_CHECK_DELAY_MS = 60_000;

export class SteamUpdateWatcher {
  readonly #options: UpdateWatcherOptions;
  readonly #states = new Map<string, MutableState>();
  #timer: NodeJS.Timeout | null = null;
  #firstCheck: NodeJS.Timeout | null = null;

  constructor(options: UpdateWatcherOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    // `unref` nos dois relógios para nenhum deles segurar o
    // processo no desligamento.
    this.#timer = setInterval(() => {
      void this.checkAll();
    }, this.#options.intervalMs);

    this.#timer.unref();

    // A primeira conferência sai logo — ver
    // `DEFAULT_FIRST_CHECK_DELAY_MS`.
    this.#firstCheck = setTimeout(() => {
      void this.checkAll();
    }, this.#options.firstCheckDelayMs ?? DEFAULT_FIRST_CHECK_DELAY_MS);

    this.#firstCheck.unref();

    this.#options.logger.info(
      {
        intervalMinutes: Math.round(this.#options.intervalMs / 60_000),
        autoUpdate: this.#options.autoUpdate,
      },
      this.#options.autoUpdate
        ? 'vigia da Steam ligado — build novo derruba, atualiza e sobe sozinho'
        : 'vigia da Steam ligado — só avisa (STEAM_AUTO_UPDATE=0)',
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    if (this.#firstCheck !== null) {
      clearTimeout(this.#firstCheck);
      this.#firstCheck = null;
    }
  }

  /**
   * Relê o BUILD EM DISCO. NÃO consulta a Steam.
   *
   * ####  O AVISO TEM QUE SUMIR QUANDO O UPDATE ENTRA  ####
   *
   * O `installed` só era relido na rodada do vigia, de quinze em
   * quinze minutos. Então uma atualização que dava certo — pelo
   * botão, pelo automático ou por um UpdateServer.bat rodado à
   * mão — deixava a faixa "há atualização publicada" na tela por
   * mais um quarto de hora, e o F5 não adiantava: a página relia
   * o mesmo retrato velho. Parece que a atualização não pegou.
   *
   * Ler o manifest custa um arquivo local de poucos KB, e é isso
   * que o GET do painel faz a cada cinco segundos. O `published`,
   * esse sim caro, continua vindo do último retrato.
   */
  async refreshInstalled(serverId: string): Promise<SteamUpdateState> {
    const config = this.#options.supervisor.configOf(serverId);

    if (config !== null) {
      const state = this.#stateFor(serverId);
      const installed = await readInstalledBuild(config.paths.installDir, config.steam.appId);

      state.installed = installed?.buildId ?? null;
    }

    return this.stateOf(serverId);
  }

  /** O último retrato. NÃO lê disco nem consulta a Steam. */
  stateOf(serverId: string): SteamUpdateState {
    const config = this.#options.supervisor.configOf(serverId);
    const state = this.#states.get(serverId);

    const installed = state?.installed ?? null;
    const published = state?.published ?? null;

    return {
      appId: config?.steam.appId ?? '258550',
      branch: config?.steam.branch ?? 'public',
      installed,
      published,
      // A trava 2 mora nesta linha: sem instalação, não há
      // "atualização disponível" — há uma instalação a fazer.
      updateAvailable: installed !== null && published !== null && installed !== published,
      checkedAt: state?.checkedAt ?? null,
      lastError: state?.lastError ?? null,
      autoUpdate: this.#options.autoUpdate,
      attempts: state?.attempts ?? 0,
      maxAttempts: MAX_ATTEMPTS_PER_BUILD,
      lastAttempt: state?.lastAttempt ?? null,
      nextAttemptAt: nextAttemptAt(state ?? null),
    };
  }

  /** Passa por todos os servidores. É o que o relógio dispara. */
  async checkAll(): Promise<void> {
    // Cede a vez: `app_info_print` e `app_update` disputam o mesmo
    // lock, e uma consulta de rotina não vale derrubar um
    // download em curso.
    if (this.#options.lock.holderOf('steamcmd') !== null) {
      this.#options.logger.debug('vigia da Steam: SteamCMD ocupado, fica para a próxima rodada');
      return;
    }

    for (const id of this.#options.supervisor.ids()) {
      try {
        await this.check(id);
      } catch (error) {
        this.#options.logger.warn(
          { server: id, err: toError(error) },
          'vigia da Steam: falha ao conferir este servidor',
        );
      }
    }
  }

  /**
   * Confere UM servidor, e atualiza se for o caso.
   *
   * Também é o que `POST /api/servers/:id/steam-update/check`
   * chama — a rota não tem lógica própria.
   */
  async check(serverId: string): Promise<SteamUpdateState> {
    const config = this.#options.supervisor.configOf(serverId);

    if (config === null) {
      return this.stateOf(serverId);
    }

    const state = this.#stateFor(serverId);
    const installed = await readInstalledBuild(config.paths.installDir, config.steam.appId);

    state.installed = installed?.buildId ?? null;

    const exe = steamCmdExe(this.#options.paths.steamCmdDir);

    if (!existsSync(exe)) {
      // Nem erro nem silêncio: é um fato que a tela precisa
      // dizer. O SteamCMD chega na primeira instalação.
      state.lastError =
        'o SteamCMD ainda não está nesta máquina — ele é baixado na primeira instalação de ' +
        'servidor. Até lá não dá para perguntar o build publicado.';
      state.checkedAt = Date.now();

      return this.stateOf(serverId);
    }

    try {
      const builds = await queryRemoteBuilds({
        steamCmdExe: exe,
        appId: config.steam.appId,
        login: config.steam.login,
        timeoutMs: QUERY_TIMEOUT_MS,
        logger: this.#options.logger,
      });

      const picked = pickBranch(builds, config.steam.appId, config.steam.branch);

      if ('buildId' in picked) {
        state.published = picked.buildId;
        state.lastError = null;
      } else {
        state.lastError = picked.message;
      }
    } catch (error) {
      // A trava 3: a consulta que não foi vira `lastError`, e não
      // um "está em dia" inventado.
      state.lastError = toError(error).message;
    }

    state.checkedAt = Date.now();

    const snapshot = this.stateOf(serverId);

    if (snapshot.updateAvailable) {
      this.#options.logger.warn(
        { server: serverId, installed: snapshot.installed, published: snapshot.published },
        'ATUALIZAÇÃO do Rust disponível',
      );

      if (this.#options.autoUpdate) {
        await this.#tryAutoUpdate(serverId, state, snapshot);
      }
    }

    return snapshot;
  }

  /** A trava 1: três tentativas por build, com uma hora entre elas. */
  async #tryAutoUpdate(
    serverId: string,
    state: MutableState,
    snapshot: SteamUpdateState,
  ): Promise<void> {
    if (state.attemptsFor !== snapshot.published) {
      state.attemptsFor = snapshot.published;
      state.attempts = 0;
      state.lastAttemptAt = null;
    }

    if (state.attempts >= MAX_ATTEMPTS_PER_BUILD) {
      this.#options.logger.error(
        { server: serverId, build: snapshot.published, attempts: state.attempts },
        'a atualização automática falhou 3 vezes para este build — desistindo. ' +
          'Atualize pelo painel e veja o log da operação.',
      );
      return;
    }

    if (state.lastAttemptAt !== null && Date.now() - state.lastAttemptAt < RETRY_INTERVAL_MS) {
      return;
    }

    state.attempts += 1;
    state.lastAttemptAt = Date.now();

    try {
      const operation = await this.#options.supervisor
        .operationsOf(serverId)
        // O build publicado vai junto: é a régua com que a
        // operação confere, no fim, se o SteamCMD realmente
        // trocou o que está em disco.
        .start({ kind: 'server-auto-update', expectedBuild: snapshot.published ?? undefined });

      state.lastAttempt = {
        operationId: operation.id,
        startedAt: operation.startedAt,
        finishedAt: null,
        status: 'running',
        message: null,
      };

      this.#options.logger.info(
        { server: serverId, operation: operation.id },
        'atualização automática disparada',
      );

      // ####  DISPARAR NÃO É SABER O QUE ACONTECEU  ####
      //
      // O `start` volta assim que a operação começa — daí em
      // diante ela roda sozinha por vários minutos. Sem acompanhar
      // o fim, o vigia (e a tela) repetiam "o agente atualiza
      // sozinho" enquanto três tentativas fracassavam em silêncio.
      // E não dá para esperar aqui: isto roda dentro da rodada de
      // conferência, e travá-la por meia hora pararia o vigia
      // inteiro.
      void this.#watchAttempt(serverId, state, operation);
    } catch (error) {
      // Recusa de pré-condição (servidor no ar sem RCON, trava
      // ocupada) não é falha da atualização: é "agora não".
      this.#options.logger.warn(
        { server: serverId, err: toError(error) },
        'não deu para disparar a atualização automática agora',
      );
    }
  }

  /**
   * Espera a operação terminar e guarda o desfecho.
   *
   * Deu certo, o build em disco mudou: a conferência sai NA HORA,
   * para o aviso de "há atualização" desaparecer da tela em vez
   * de sobreviver até a próxima rodada de quinze minutos. Deu
   * errado, o motivo fica guardado — é o que a tela passa a
   * mostrar no lugar da promessa de que o agente resolve sozinho.
   */
  async #watchAttempt(serverId: string, state: MutableState, operation: Operation): Promise<void> {
    const finished = await operation.done;

    state.lastAttempt = {
      operationId: finished.id,
      startedAt: finished.startedAt,
      finishedAt: finished.finishedAt,
      status: finished.status === 'running' ? 'running' : finished.status,
      message: finished.message,
    };

    if (finished.status !== 'succeeded') {
      this.#options.logger.warn(
        { server: serverId, operation: finished.id, status: finished.status },
        'a atualização automática não terminou bem',
      );

      return;
    }

    // As tentativas eram deste build. Ele entrou: a conta zera, e
    // não fica pendurada esperando o próximo update da Facepunch
    // para ser reaproveitada.
    state.attemptsFor = null;
    state.attempts = 0;
    state.lastAttemptAt = null;

    try {
      await this.check(serverId);
    } catch (error) {
      this.#options.logger.warn(
        { server: serverId, err: toError(error) },
        'a atualização deu certo, mas a reconferência do build falhou',
      );
    }
  }

  #stateFor(serverId: string): MutableState {
    let state = this.#states.get(serverId);

    if (state === undefined) {
      state = {
        installed: null,
        published: null,
        checkedAt: null,
        lastError: null,
        attemptsFor: null,
        attempts: 0,
        lastAttemptAt: null,
        lastAttempt: null,
      };

      this.#states.set(serverId, state);
    }

    return state;
  }
}

/**
 * Quando sai a próxima tentativa automática. `null` quando não há
 * uma marcada — porque nenhuma foi gasta, ou porque as três já
 * foram e agora é com o humano.
 *
 * É um horário CALCULADO, e não agendado: a rodada do vigia é que
 * dispara, e ela só passa de quinze em quinze minutos. Então isto
 * é o "não antes de", que é justamente o que a tela precisa dizer
 * para ninguém ficar olhando o relógio.
 */
function nextAttemptAt(state: MutableState | null): number | null {
  if (state === null || state.lastAttemptAt === null) {
    return null;
  }

  if (state.attempts >= MAX_ATTEMPTS_PER_BUILD) {
    return null;
  }

  return state.lastAttemptAt + RETRY_INTERVAL_MS;
}
