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
import type { OperationLock } from '../ops/operations.js';
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
}

export interface UpdateWatcherOptions {
  readonly supervisor: ServerSupervisor;
  readonly paths: AgentPaths;
  readonly lock: OperationLock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly autoUpdate: boolean;
}

export class SteamUpdateWatcher {
  readonly #options: UpdateWatcherOptions;
  readonly #states = new Map<string, MutableState>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: UpdateWatcherOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    // `unref` para o relógio não segurar o processo no
    // desligamento. A primeira rodada sai depois do primeiro
    // intervalo: no boot, o agente tem coisa melhor a fazer do
    // que falar com a Steam.
    this.#timer = setInterval(() => {
      void this.checkAll();
    }, this.#options.intervalMs);

    this.#timer.unref();

    this.#options.logger.info(
      {
        intervalMinutes: Math.round(this.#options.intervalMs / 60_000),
        autoUpdate: this.#options.autoUpdate,
      },
      'vigia da Steam ligado',
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** O último retrato. NÃO consulta a Steam. */
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
        .start({ kind: 'server-auto-update' });

      this.#options.logger.info(
        { server: serverId, operation: operation.id },
        'atualização automática disparada',
      );
    } catch (error) {
      // Recusa de pré-condição (servidor no ar sem RCON, trava
      // ocupada) não é falha da atualização: é "agora não".
      this.#options.logger.warn(
        { server: serverId, err: toError(error) },
        'não deu para disparar a atualização automática agora',
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
      };

      this.#states.set(serverId, state);
    }

    return state;
  }
}
