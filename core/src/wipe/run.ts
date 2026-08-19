// ============================================================
//  run.ts  -  A MÁQUINA DE PASSOS. É ela que apaga.
//
//      avisar > esvaziar > parar > backup > apagar >
//              configurar > subir > pos-wipe
//
//  ####  TODO PASSO É IDEMPOTENTE  ####
//
//  E não é elegância: é o que torna `resume` seguro. Apagar num
//  diretório já limpo é `done`, não `failed`; parar um servidor já
//  parado é `done`; zipar de novo escreve outro zip e o velho é
//  podado. Sem isso, a única saída de uma execução interrompida
//  seria "rodar tudo de novo" — e no meio de um wipe isso
//  significa apagar um mundo que já é o NOVO.
//
//  ####  A RETOMADA COMEÇA NO PRIMEIRO PASSO QUE NÃO ESTÁ `done`  ####
//
//  Os passos correm em ordem e o estado de cada um está no banco.
//  Se `configurar` terminou, a retomada começa em `subir` e NUNCA
//  volta a `apagar`. E, como rede de segurança para o caso que a
//  ordem não cobre — alguém subiu o servidor à mão depois de uma
//  falha —, `apagar` RECUSA rodar com o processo de pé: o mundo
//  que estaria em disco ali seria o novo.
//
//  ------------------------------------------------------------
//  ####  O QUE DERRUBA O WIPE, E O QUE NÃO DERRUBA  ####
//
//  Derruba:   backup (é a única volta atrás que existe),
//             parar, apagar, configurar.
//  Não derruba: avisar (o RCON pode ter caído — o jogador perde o
//             aviso, e é ruim; perder o wipe é pior), esvaziar
//             (tem teto, e o teto vencido segue em frente),
//             pos-wipe (ressincronizar VIP que falha não desfaz um
//             mundo que já nasceu).
//
//  ------------------------------------------------------------
//  ####  UMA SÓ MANEIRA DE FALAR COM O CHAT  ####
//
//  Todo texto que sai daqui passa pelo `Broadcaster` (Frente E).
//  As falas dos offsets ("faltam 15 min") passam pelo
//  `WipeAnnouncer` (Frente F), que também usa o `Broadcaster`.
//  Este arquivo não monta comando de RCON de chat em lugar nenhum.
// ============================================================

import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerConfig } from '../config.js';
import type { MapPoolPick, MapPoolRepository } from '../db/map-pool-repository.js';
import type {
  WipeAnnounceSettings,
  WipeExecSettings,
  WipeRunRecord,
  WipeRunsRepository,
  WipeWorld,
} from '../db/wipe-runs-repository.js';
import type { WipeScheduleRepository } from '../db/wipe-schedule-repository.js';
import type { WipesRepository } from '../db/wipes-repository.js';
import type { Broadcaster } from '../game/broadcast.js';
import type { Logger } from '../logger.js';
import type { Operation } from '../ops/operations.js';
import type { BpPolicy, MapPoolEntry, WipePlan, WipePlanKind, WipeRunStep } from '../types/wipe.js';
import { toError } from '../util.js';
import { backupSaveFolder, checkBackupSpace } from './backup.js';
import { KEEP_CUSTOM_IN_FORCED_REASON, pinnedRejection } from './map-pool.js';
import {
  currentWorldReader,
  mapOfPlan,
  mapOfPool,
  type WipeCurrentWorldReader,
} from './next-wipe.js';
import { resolvePluginDataTargets } from './plugin-data.js';
import { classifySaveFolder, saveFolderPath } from './save-files.js';

// ------------------------------------------------------------
//  §1  O QUE A MÁQUINA PRECISA DE FORA
// ------------------------------------------------------------

/**
 * Parar e subir o servidor — pelo caminho que já existe.
 *
 * ####  POR QUE ISTO É UMA INTERFACE, E NÃO UM `import`  ####
 *
 * Quem sabe parar um servidor de Rust é o `OperationsService`: o
 * `quit` pelo RCON que salva antes de sair, os dois minutos de
 * espera, o `force` que mata o processo, o "subiu é o RCON
 * responder". Reimplementar isso aqui daria dois jeitos de parar
 * um servidor, e o daqui seria o que ninguém testa.
 *
 * Mas o wipe-run JÁ É uma operação, e ela já segurou a trava de
 * `server:<id>`: chamar `OperationsService.start('server-stop')`
 * daqui esbarraria na própria trava. Por isso o serviço passa
 * estes quatro verbos direto, sem passar pela trava de novo.
 */
export interface WipeServerControl {
  isRunning(): Promise<boolean>;
  /** `quit` pelo RCON. `force` mata o processo — só quando pedido. */
  stop(force: boolean): Promise<void>;
  /** Sobe e espera o RCON responder. */
  start(): Promise<void>;
  /** `null` = não deu para perguntar, e isso é DIFERENTE de zero. */
  online(): Promise<number | null>;
  readonly rconConnected: boolean;
}

/**
 * Quem transforma UM offset em UMA fala.
 *
 * É a Frente F. O relógio, a ordem dos offsets e a marca do que já
 * saiu são DESTE arquivo: assim a Frente F só precisa saber
 * escrever a frase, e um aviso perdido não tem como derrubar o
 * wipe — quem chama é que decide isso, e a decisão está aqui.
 *
 * LANÇAR É PERMITIDO, e o `catch` do passo `avisar` segura: a fala
 * que não saiu vira uma linha no log e o wipe segue. Quem entrega
 * (wipe/announce.ts) deixa a falha do transporte subir DE
 * PROPÓSITO — um locutor que a engolisse faria o `count` deste
 * passo somar avisos que ninguém leu, e o histórico diria
 * "2 aviso(s) no chat" com zero aviso no chat.
 */
export interface WipeAnnouncer {
  announceOffset(input: {
    readonly serverId: string;
    readonly runId: number;
    /** Quando o mundo zera, em epoch ms. */
    readonly wipeAt: number;
    readonly now: number;
    /** Quantos minutos faltam, segundo o offset configurado. */
    readonly offsetMinutes: number;
    readonly kind: WipePlanKind;
    readonly bpPolicy: BpPolicy;
    readonly settings: WipeAnnounceSettings;
  }): Promise<void>;
}

/** O recorte do supervisor que a execução usa. */
export interface WipeServers {
  configOf(id: string): ServerConfig | null;
  updateSettings(id: string, patch: Readonly<Record<string, string | number | boolean>>): string[];
}

/** Quem sabe quando o mundo nasceu. É o `WipeClock` de game/wipe.ts. */
export interface WipeWorldClock {
  /** Esquece o que sabia. Chamado quando o mundo novo sobe. */
  forget(serverId: string): void;
  /** `null` = não deu para perguntar. */
  saveCreatedAt(serverId: string): Promise<number | null>;
}

/**
 * Quem guarda e devolve o que o jogador APRENDEU.
 *
 * É a Frente I, e ela entra em dois pontos desta máquina: o
 * snapshot, antes de o mundo ser apagado, e a fila de devolução,
 * no `pos-wipe`. A implementação está em wipe/blueprints.ts.
 *
 * ####  FALHAR AQUI NÃO CANCELA O WIPE  ####
 *
 * O contrato é o oposto do resto do arquivo: `snapshot` PODE
 * lançar, e quem segura é o `catch` do chamador — a política do
 * run cai para `wipe` e a linha do log diz isso. Um wipe travado
 * porque o export não respondeu é pior que um wipe sem devolução.
 */
export interface WipeBlueprints {
  snapshot(input: {
    readonly serverId: string;
    readonly wipeRunId: number;
  }): Promise<{ readonly players: number; readonly items: number }>;
  /**
   * Quantas devoluções ficaram devendo.
   *
   * `0` = não havia snapshot DESTA execução, e é assim que "a
   * política caiu para wipe" chega à linha do log.
   */
  enqueue(input: {
    readonly serverId: string;
    readonly wipeRunId: number;
    readonly wipeAt: number;
  }): number;
}

export interface WipeRunnerDeps {
  readonly runs: WipeRunsRepository;
  readonly wipes: WipesRepository;
  readonly schedule: WipeScheduleRepository;
  readonly mapPool: MapPoolRepository;
  readonly servers: WipeServers;
  readonly world: WipeWorldClock;
  /** A ÚNICA maneira de mandar texto ao chat. Ver o cabeçalho. */
  readonly broadcaster?: Broadcaster | undefined;
  /** A Frente F. Sem ele, o passo `avisar` só espera a hora. */
  readonly announcer?: WipeAnnouncer | undefined;
  /** VIP, loadouts, kits e catálogo, depois de o mundo novo subir. */
  readonly resync?: ((serverId: string) => Promise<void>) | undefined;
  /** A Frente I. Sem ela, `wipe_except_vip` se comporta como `wipe`. */
  readonly blueprints?: WipeBlueprints | undefined;
  readonly logger?: Logger | undefined;
}

export interface WipeRunRequest {
  readonly serverId: string;
  readonly runId: number;
  readonly operation: Operation;
  readonly control: WipeServerControl;
  /** Retomada: os passos já `done` não rodam de novo. */
  readonly resume?: boolean;
}

/** De quanto em quanto tempo o passo `esvaziar` reconta os jogadores. */
const DRAIN_POLL_MS = 15_000;

/** O passo mais longo que o `avisar` aceita esperar de uma vez. */
const ANNOUNCE_TICK_MS = 30_000;

// ------------------------------------------------------------
//  §2  A MÁQUINA
// ------------------------------------------------------------

/**
 * O recorte de `WipeRunner` que o `OperationsService` conhece.
 *
 * ####  ELE EXISTE POR CAUSA DA ORDEM DE MONTAGEM  ####
 *
 * O `WipeRunner` precisa do supervisor (para `updateSettings`) e do
 * `Broadcaster` (que precisa do supervisor também), e o supervisor
 * precisa do runner para entregá-lo a cada `OperationsService`. Um
 * dos dois tem que chegar depois. Com esta interface, o index.ts
 * entrega ao supervisor um objeto de uma linha que encaminha para o
 * runner de verdade quando ele existir — o mesmo padrão que o
 * arquivo já usa para o VIP, os banimentos e a presença.
 */
export interface WipeExecutor {
  run(request: WipeRunRequest): Promise<WipeRunRecord>;
}

export class WipeRunner implements WipeExecutor {
  readonly #deps: WipeRunnerDeps;

  /**
   * O mundo em que cada servidor está agora, com a marca do `.map`.
   *
   * Ele é montado UMA vez, e do mesmo jeito que o index.ts monta o
   * do chat e o da tela do jogo: a pergunta "este mundo pode ficar
   * num wipe forçado?" precisa ter a mesma resposta aqui, onde o
   * `.ini` é escrito, e lá, onde o wipe é anunciado.
   */
  readonly #world: WipeCurrentWorldReader;

  constructor(deps: WipeRunnerDeps) {
    this.#deps = deps;
    this.#world = currentWorldReader({ servers: deps.servers, mapPool: deps.mapPool });
  }

  /**
   * Roda a execução inteira, do primeiro passo que falta ao fim.
   *
   * @throws quando um passo que DERRUBA o wipe falha. Quem chama é
   * o `OperationsService`, que já sabe transformar isso em
   * operação falhada com a frase no log.
   */
  async run(request: WipeRunRequest): Promise<WipeRunRecord> {
    const { serverId, runId, operation } = request;
    const runs = this.#deps.runs;

    let run = runs.get(serverId, runId);

    if (run === null) {
      throw new Error(
        `a execução de wipe ${String(runId)} não existe para o servidor "${serverId}"`,
      );
    }

    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      throw new Error(`o servidor "${serverId}" não existe mais neste agente`);
    }

    const exec = runs.getExecSettings(serverId);

    runs.update(serverId, runId, { status: 'running', operationId: operation.id, finishedAt: null });

    // A retomada começa no primeiro passo que não terminou. Ver o
    // cabeçalho: é a ordem que impede `apagar` de rodar depois de
    // `configurar`.
    const done = new Set(
      run.steps.filter((step) => step.status === 'done' || step.status === 'skipped').map((s) => s.step),
    );

    if (request.resume === true && done.size > 0) {
      operation.log(
        `[wipe] retomando: ${String(done.size)} passo(s) já concluído(s) não vão rodar de novo.`,
      );
    }

    const steps: readonly { readonly name: WipeRunStep; readonly fatal: boolean; readonly go: () => Promise<string> }[] = [
      { name: 'avisar', fatal: false, go: () => this.#avisar(request, run as WipeRunRecord, exec) },
      { name: 'esvaziar', fatal: false, go: () => this.#esvaziar(request, exec) },
      { name: 'parar', fatal: true, go: () => this.#parar(request, exec) },
      { name: 'backup', fatal: true, go: () => this.#backup(request, config, exec) },
      { name: 'apagar', fatal: true, go: () => this.#apagar(request, config, run as WipeRunRecord, exec) },
      { name: 'configurar', fatal: true, go: () => this.#configurar(request, run as WipeRunRecord) },
      { name: 'subir', fatal: true, go: () => this.#subir(request) },
      { name: 'pos-wipe', fatal: false, go: () => this.#posWipe(request, run as WipeRunRecord, exec) },
    ];

    for (const step of steps) {
      if (done.has(step.name)) {
        continue;
      }

      if (operation.cancelled) {
        runs.markStep(runId, step.name, 'skipped', 'a execução foi cancelada antes deste passo');
        continue;
      }

      // ####  O SNAPSHOT DE BLUEPRINTS ENTRA AQUI, E NÃO ANTES DE
      //       `apagar`  ####
      //
      // Ele é lido pelo PLUGIN, dentro do jogo: entre `parar` e
      // `apagar` o servidor já está fora do ar e não há a quem
      // perguntar. Este é o último instante em que o RCON ainda
      // responde — e é depois de `esvaziar`, então o persistance
      // já recebeu o que os jogadores aprenderam na sessão.
      if (step.name === 'parar') {
        await this.#snapshotBlueprints(request, run as WipeRunRecord);
      }

      runs.markStep(runId, step.name, 'running');
      operation.log(`[wipe] ${step.name}...`);

      try {
        const message = await step.go();

        runs.markStep(runId, step.name, 'done', message);
        operation.log(`[wipe] ${step.name}: ${message}`);
      } catch (error) {
        const message = toError(error).message;

        runs.markStep(runId, step.name, 'failed', message);
        operation.log(`[wipe] ${step.name} FALHOU: ${message}`);

        if (step.fatal) {
          const finished = runs.update(serverId, runId, {
            status: 'failed',
            finishedAt: Date.now(),
            message: `Parou no passo "${step.name}": ${message}`,
          });

          this.#markPlan(finished, 'failed');

          throw error;
        }

        // Não fatal: o log já registrou, e a execução segue. Um
        // aviso perdido não pode zerar a agenda do servidor.
        this.#deps.logger?.warn(
          { server: serverId, run: runId, step: step.name, err: toError(error) },
          'passo de wipe falhou sem derrubar a execução',
        );
      }

      run = runs.get(serverId, runId) ?? run;
    }

    const status = operation.cancelled ? 'cancelled' : 'done';

    const finished = runs.update(serverId, runId, {
      status,
      finishedAt: Date.now(),
      message:
        status === 'cancelled'
          ? 'Cancelada. Confira em que passo ela parou antes de tentar de novo.'
          : 'Wipe concluído.',
    });

    this.#markPlan(finished, status === 'cancelled' ? 'failed' : 'done');

    return finished;
  }

  // ----------------------------------------------------------
  //  §3  OS PASSOS
  // ----------------------------------------------------------

  /**
   * As falas dos offsets, e a espera até a hora do wipe.
   *
   * ####  O RELÓGIO É DAQUI; A FRASE É DA FRENTE F  ####
   *
   * Este passo espera, escolhe o offset e grava a marca; o
   * `WipeAnnouncer` só transforma um offset numa fala. É o que
   * garante as duas regras de uma vez: um aviso perdido não
   * derruba o wipe (o `catch` é aqui), e um aviso não é reenviado
   * depois de um restart do agente (a marca fica em
   * `wipe_run_steps`, na mensagem deste passo).
   */
  async #avisar(
    request: WipeRunRequest,
    run: WipeRunRecord,
    exec: WipeExecSettings,
  ): Promise<string> {
    const { operation, runId, serverId } = request;
    const sent = new Set(parseSentOffsets(stepMessageOf(run, 'avisar')));
    const offsets = [...exec.announce.offsetsMinutes].sort((a, b) => b - a);

    if (offsets.length === 0) {
      // Espera a hora mesmo assim: sem isto, um wipe agendado para
      // daqui a uma hora zeraria o servidor agora.
      await this.#waitUntil(run.wipeAt, operation);

      return 'sem avisos configurados — esperei a hora e segui.';
    }

    let count = 0;

    for (const offset of offsets) {
      if (operation.cancelled) {
        break;
      }

      const at = run.wipeAt - offset * 60_000;

      if (sent.has(offset)) {
        continue;
      }

      if (at < Date.now() - 60_000) {
        // O offset já passou (execução criada tarde, ou retomada
        // depois dele). Avisar "faltam 24 h" quando faltam dez
        // minutos seria pior que não avisar.
        sent.add(offset);
        continue;
      }

      await this.#waitUntil(at, operation);

      if (operation.cancelled) {
        break;
      }

      if (this.#deps.announcer === undefined) {
        operation.log(
          `[wipe] aviso de ${String(offset)} min não saiu: nenhum locutor de wipe está ` +
            'registrado neste agente.',
        );
      } else {
        try {
          await this.#deps.announcer.announceOffset({
            serverId,
            runId,
            wipeAt: run.wipeAt,
            now: Date.now(),
            offsetMinutes: offset,
            kind: run.kind,
            bpPolicy: run.bpPolicy,
            settings: exec.announce,
          });

          count += 1;
        } catch (error) {
          // ####  AVISO É MELHOR-ESFORÇO  ####
          //
          // O RCON pode ter caído, o plugin pode não estar
          // carregado. O jogador perde o aviso, e isso é ruim;
          // perder o wipe porque o chat não respondeu é pior.
          operation.log(
            `[wipe] o aviso de ${String(offset)} min não saiu: ${toError(error).message}`,
          );
        }
      }

      // A marca é gravada mesmo quando a fala falhou: reenviar o
      // aviso de 24 h no restart seguinte seria anunciar um wipe
      // que já passou.
      sent.add(offset);
      this.#deps.runs.markStep(runId, 'avisar', 'running', formatSentOffsets(sent));
    }

    await this.#waitUntil(run.wipeAt, operation);

    return count === 0
      ? `nenhum aviso saiu (${String(sent.size)} offset(s) já vencido(s) ou sem locutor).`
      : `${String(count)} aviso(s) no chat, o último ${String(Math.min(...offsets))} min antes.`;
  }

  /** Anuncia e espera a saída, com teto. Nunca espera para sempre. */
  async #esvaziar(request: WipeRunRequest, exec: WipeExecSettings): Promise<string> {
    const { control, operation } = request;

    if (!exec.drain.enabled) {
      return 'desligado na configuração — fui direto para o parar.';
    }

    if (!(await control.isRunning())) {
      return 'o servidor já estava parado.';
    }

    const before = await control.online();

    if (before === 0) {
      return 'ninguém online.';
    }

    await this.#say(
      request,
      'O WIPE COMECOU. O servidor vai reiniciar agora e o mundo sera zerado. Ate ja!',
      exec.announce,
    );

    const deadline = Date.now() + exec.drain.waitMinutes * 60_000;

    while (Date.now() < deadline && !operation.cancelled) {
      const online = await control.online();

      if (online === 0) {
        return `${String(before ?? 0)} jogador(es) saíram (0 restantes).`;
      }

      await delay(DRAIN_POLL_MS, operation.signal);
    }

    const left = await control.online();

    // O teto vencido NÃO derruba: o `quit` do passo seguinte salva
    // o mundo antes de sair, e quem ficou volta com o que tinha
    // até o último save.
    return left === null
      ? `esperei ${String(exec.drain.waitMinutes)} min; não deu para contar quem restou.`
      : `esperei ${String(exec.drain.waitMinutes)} min e ainda havia ${String(left)} online — o ` +
          'quit salva o mundo antes de encerrar.';
  }

  /** `quit` pelo RCON, que salva antes de sair. */
  async #parar(request: WipeRunRequest, exec: WipeExecSettings): Promise<string> {
    const { control } = request;

    if (!(await control.isRunning())) {
      return 'o servidor já estava parado.';
    }

    // ####  `force` SÓ QUANDO O OPERADOR PEDIU  ####
    //
    // Ele mata o processo, e o que se perde é tudo desde o último
    // save automático. O caminho normal é o `quit`, que grava o
    // mundo — e é justamente o mundo que o backup vai copiar no
    // passo seguinte.
    await control.stop(exec.drain.force);

    if (await control.isRunning()) {
      throw new Error(
        'o servidor continua no ar depois do quit. Sem ele parado, o Rust mantém os arquivos do ' +
          'save abertos e reescreve no próximo saveinterval o que for apagado. Pare o servidor à ' +
          'mão e retome esta execução, ou ligue "matar o processo" na Configuração.',
      );
    }

    return exec.drain.force
      ? 'encerrado (com force ligado — o que ficou do último save foi perdido).'
      : 'quit pelo RCON — o mundo foi salvo antes de sair.';
  }

  /** O zip do save. É a única volta atrás que existe. */
  async #backup(
    request: WipeRunRequest,
    config: ServerConfig,
    exec: WipeExecSettings,
  ): Promise<string> {
    if (!exec.backup.enabled) {
      return 'desligado na configuração — este wipe não tem volta.';
    }

    const saveDir = saveFolderPath(config.paths.installDir, config.identity);
    const space = await checkBackupSpace(saveDir, config.paths.backupsDir);

    // A conferência de verdade aconteceu ANTES de parar o servidor
    // (ver a pré-condição da rota). Esta é a segunda, e ela existe
    // para a retomada: entre a primeira e agora pode ter passado
    // um dia inteiro.
    if (!space.ok && space.reason !== null) {
      throw new Error(space.reason);
    }

    const result = await backupSaveFolder({
      saveDir,
      backupsDir: config.paths.backupsDir,
      keep: exec.backup.keep,
      onLine: (line) => request.operation.log(line),
    });

    if (result === null) {
      return 'a pasta do save está vazia — não havia o que copiar.';
    }

    this.#deps.runs.update(request.serverId, request.runId, { backupPath: result.path });

    const podados = result.pruned.length === 0 ? '' : ` ${String(result.pruned.length)} antigo(s) podado(s).`;

    return `${String(result.files)} arquivo(s), ${mb(result.bytes)} -> ${result.path}.${podados}`;
  }

  /**
   * O passo que apaga.
   *
   * ####  ELE RECUSA COM O SERVIDOR DE PÉ  ####
   *
   * Duas razões, e as duas bastam sozinhas: o Rust mantém os
   * arquivos abertos e reescreve no próximo `saveinterval` o que
   * for removido; e, numa retomada em que alguém subiu o servidor
   * à mão, o mundo em disco já é o NOVO — apagá-lo seria zerar o
   * servidor uma segunda vez, sem backup do mundo que acabou de
   * nascer.
   */
  async #apagar(
    request: WipeRunRequest,
    config: ServerConfig,
    run: WipeRunRecord,
    exec: WipeExecSettings,
  ): Promise<string> {
    if (await request.control.isRunning()) {
      throw new Error(
        'o servidor está no ar, e este passo não apaga arquivo com ele de pé. Se esta é uma ' +
          'retomada e alguém subiu o servidor à mão, o mundo em disco pode já ser o NOVO — pare ' +
          'o servidor e confira antes de retomar.',
      );
    }

    const saveDir = saveFolderPath(config.paths.installDir, config.identity);
    const summary = await classifySaveFolder(saveDir, run.bpPolicy);

    if (!summary.exists) {
      // Pasta que não existe é sucesso: é o servidor que nunca
      // subiu, e é também o desfecho de uma retomada depois de o
      // passo ter terminado.
      return 'a pasta do save não existe — não havia o que apagar.';
    }

    let removed = 0;
    let bytes = 0;

    for (const file of summary.files) {
      if (file.fate !== 'delete') {
        continue;
      }

      const path = join(saveDir, file.name);

      try {
        await rm(path, { force: true });
        removed += 1;
        bytes += file.bytes;
      } catch (error) {
        throw new Error(
          `não consegui apagar ${path}: ${toError(error).message}. Com o mundo pela metade, o ` +
            'servidor pode subir num estado que ninguém escolheu — resolva e retome.',
        );
      }
    }

    let plugins = 0;

    if (run.fullWipe && exec.pluginData.patterns.length > 0) {
      const targets = await resolvePluginDataTargets({
        installDir: config.paths.installDir,
        identity: config.identity,
        selected: exec.pluginData.patterns,
        bpPolicy: run.bpPolicy,
      });

      for (const target of targets) {
        try {
          const size = await sizeOf(target);

          await rm(target, { force: true });
          plugins += 1;
          bytes += size;
        } catch (error) {
          // ####  O FULL WIPE NÃO DERRUBA O WIPE  ####
          //
          // Um `.json` de plugin que não some (arquivo aberto,
          // permissão) é um problema de plugin. O mundo já foi
          // apagado; parar aqui deixaria o servidor sem mundo e
          // sem subir.
          request.operation.log(
            `[wipe] dado de plugin não apagado: ${target} (${toError(error).message})`,
          );
        }
      }
    }

    const extra = plugins === 0 ? '' : ` + ${String(plugins)} de plugin`;

    return removed === 0
      ? 'nada a apagar: a pasta já estava limpa.'
      : `${String(removed)} arquivo(s)${extra}, ${mb(bytes)} liberados.`;
  }

  /**
   * A seed e o tamanho do mundo novo, pelo supervisor.
   *
   * ####  QUEM ESCOLHE O MUNDO É O PLANO  ####
   *
   * A escolha é `mapOfPlan`, de wipe/next-wipe.ts — a MESMA que o
   * chat responde em `{wipe.mapa}` e que a tela CALENDÁRIO desenha
   * para o VIP prata. Este passo CONSOME o que ela escolheu; ele
   * não escolhe de novo. Enquanto escolhia sozinho — a cabeça da
   * fila, sempre —, um plano `keep` trocava o mundo assim mesmo e
   * um `fixed` apontando para a entrada #2 subia a #1, com a tela
   * anunciando a certa o tempo todo.
   *
   * Sem plano (o "WIPAR AGORA" com hora marcada) a fila é a
   * resposta, como sempre foi.
   *
   * ####  NUNCA ESCREVER O `.ini` DIRETO  ####
   *
   * `supervisor.updateSettings` preserva os comentários do
   * arquivo, confere as portas e relê o resultado. Escrever aqui
   * daria dois donos do mesmo arquivo, e o segundo apagaria o que
   * o humano escreveu nele.
   */
  async #configurar(request: WipeRunRequest, run: WipeRunRecord): Promise<string> {
    const { serverId } = request;

    if (run.mapAfter !== null) {
      // ####  É ISTO QUE FAZ A RETOMADA SER SEGURA  ####
      //
      // O mundo gravado é a marca de que este passo terminou.
      // Rodar de novo sem ela queimaria uma SEGUNDA entrada da
      // fila, e num plano `keep` reescreveria o `.ini` de um mundo
      // que ninguém mandou trocar.
      return `o mundo novo já estava escolhido: ${describeWorld(run.mapAfter)}.`;
    }

    const plan = run.planId === null ? null : this.#deps.schedule.getPlan(serverId, run.planId);

    // A MESMA `kind` que a decisão olha. Num wipe forçado a fila
    // pula o mapa custom sem marca de versão, e as duas contas
    // precisam concordar sobre qual wipe é este.
    const forced = (plan ?? run).kind === 'forced';

    const decision =
      plan === null
        ? mapOfPool({ mapPool: this.#deps.mapPool }, serverId, forced)
        : mapOfPlan({ mapPool: this.#deps.mapPool, world: this.#world }, plan);

    if (decision.source === 'keep') {
      return this.#manterMundo(request, run);
    }

    // ####  O `keep` QUE O FORÇADO RECUSOU  ####
    //
    // `mapOfPlan` já decidiu — o mundo sai da fila —, e sem esta
    // linha o log diria só "entrada #7 da fila" para um plano que
    // manda MANTER: quem lê o histórico não teria como saber que a
    // ordem do admin foi recusada, nem por quê. A recusa em si o
    // admin já viu na agenda e na prévia; aqui é o registro de que
    // ela valeu na madrugada.
    if (plan?.mapSource === 'keep') {
      request.operation.log(
        `[wipe] o plano manda MANTER o mundo, e neste wipe FORÇADO ele não pode ficar: ` +
          `${KEEP_CUSTOM_IN_FORCED_REASON}. O mundo sai da fila.`,
      );
    }

    // ####  A ENTRADA APONTADA É A QUE O PLANO APONTOU  ####
    //
    // E não a que a decisão devolveu. `fixed` consome a entrada do
    // `mapPoolId`, esteja ela onde estiver na fila; quando esse
    // ponteiro não serve mais — sumiu, já foi usada, ainda está
    // `generating`, ou é um `.map` custom sem a marca de
    // compatibilidade num wipe forçado —, `mapOfPlan` CAI para a
    // fila e devolve a cabeça dela, também como `source: 'entry'`.
    //
    // Sem comparar o id, a queda passava por escolha: o log e o
    // `wipe_run_steps.message` diziam "escolhida a dedo no plano"
    // de uma entrada que ninguém escolheu, e o `pickForWipe` — que
    // é quem monta a lista de puladas — não rodava, então o aviso
    // de mapa custom recusado sumia do log.
    const pinned =
      plan?.mapSource === 'fixed' &&
      plan.mapPoolId !== null &&
      decision.source === 'entry' &&
      decision.entry.id === plan.mapPoolId
        ? decision.entry
        : null;

    if (plan?.mapSource === 'fixed' && pinned === null) {
      this.#avisarPonteiroRecusado(request, plan, forced);
    }

    // ####  ESCOLHER NÃO É QUEIMAR  ####
    //
    // `pickForWipe` só LÊ: ele diz qual entrada seria consumida e
    // quais ficaram pelo caminho. Quem a marca `used` é o fim
    // deste passo, depois de o `.ini` estar gravado.
    //
    // `MapPoolEntry` e não `MapPoolRecord`: daqui para baixo só o
    // contrato mínimo é lido — nome, seed, tamanho, `levelUrl` e o
    // id —, e é ele que a decisão devolve.
    const picked: { readonly entry: MapPoolEntry | null; readonly skipped: MapPoolPick['skipped'] } =
      pinned === null
        ? this.#deps.mapPool.pickForWipe(serverId, { forced })
        : { entry: pinned, skipped: [] };

    for (const skipped of picked.skipped) {
      request.operation.log(`[wipe] pulei a entrada #${String(skipped.id)} da fila: ${skipped.reason}`);
    }

    // ####  O SORTEIO TAMBÉM SÓ ESCOLHE  ####
    //
    // A fila sem nada utilizável sorteia — e `drawForWipe` NÃO
    // grava linha nenhuma: ele devolve a seed, e a linha dela
    // nasce lá embaixo, junto da queima da fila, depois do `.ini`.
    // Enquanto o sorteio inseria e queimava aqui em cima, um
    // `updateSettings` que lançava deixava para trás um mundo
    // `used` que nunca subiu, e a retomada sorteava outro: medido,
    // com o `.ini` lançando duas vezes, três linhas `used` para um
    // wipe só — e três seeds fantasmas empurrando a memória de
    // `recentSeeds` para fora da janela dela.
    const escolha =
      picked.entry === null
        ? ({ tipo: 'sorteio', sorteada: this.#deps.mapPool.drawForWipe(serverId) } as const)
        : ({ tipo: 'fila', entry: picked.entry } as const);

    const mundo =
      escolha.tipo === 'fila'
        ? {
            level: escolha.entry.level,
            seed: escolha.entry.seed,
            worldSize: escolha.entry.worldSize,
            levelUrl: escolha.entry.levelUrl,
          }
        : {
            level: escolha.sorteada.level,
            seed: escolha.sorteada.seed,
            worldSize: escolha.sorteada.worldSize,
            levelUrl: null,
          };

    const patch: Record<string, string | number> = {};

    if (mundo.level !== null) {
      patch.map = mundo.level;
    }

    if (mundo.seed !== null) {
      patch.seed = mundo.seed;
    }

    if (mundo.worldSize !== null) {
      patch.worldSize = mundo.worldSize;
    }

    // Sempre gravada, inclusive VAZIA: um mapa procedural depois
    // de um custom precisa LIMPAR a chave, senão o servidor sobe
    // baixando o `.map` de novo e o wipe não troca mundo nenhum.
    patch.levelUrl = mundo.levelUrl ?? '';

    // ####  O `.ini` PRIMEIRO, A FILA POR ÚLTIMO  ####
    //
    // `updateSettings` escreve em disco, confere as portas e relê
    // o arquivo — é o único passo daqui que falha por conta
    // própria, e ele LANÇA (ver servers/supervisor.ts). Queimando
    // a entrada antes dele, um erro deixava a fila consumida e o
    // `map_after` nulo: a retomada rodava o passo inteiro de novo
    // e queimava a SEGUNDA entrada, e num plano `fixed` via a
    // apontada já `used`, caía para a cabeça da fila e subia o
    // mundo que o admin explicitamente não queria.
    //
    // Nesta ordem a retomada é o caso normal: um erro do `.ini`
    // não consome nada — nem da curadoria, nem do sorteio —, e a
    // volta reencontra a MESMA fila, toma a MESMA decisão e
    // escreve o MESMO patch.
    this.#deps.servers.updateSettings(serverId, patch);

    // ####  E AS DUAS ESCRITAS DO BANCO SÃO UMA SÓ  ####
    //
    // O mundo em `map_after` (a marca de idempotência que a
    // retomada lê) e a fila queimada sobem juntos ou não sobem.
    // Entre uma e outra, o agente que caía deixava a entrada
    // `ready` sem registro de que já tinha subido: a retomada
    // pulava o passo, e o wipe SEGUINTE consumia a mesma entrada —
    // a mesma seed dois wipes em fila, com a régua do VIP
    // anunciando no intervalo, como "o próximo mundo", o mundo que
    // já estava no ar. Ver `commitWorld`.
    this.#deps.runs.commitWorld(serverId, request.runId, (): WipeWorld => {
      if (escolha.tipo === 'fila') {
        this.#deps.mapPool.markUsed(serverId, escolha.entry.id);

        return { ...mundo, mapPoolId: escolha.entry.id, drawn: false };
      }

      // A linha do sorteio nasce AQUI, e já consumida: ela não
      // existia antes deste passo, e não há fila a queimar.
      const linha = this.#deps.mapPool.recordDrawn(serverId, escolha.sorteada);

      return { ...mundo, mapPoolId: linha.id, drawn: true };
    });

    if (escolha.tipo === 'sorteio') {
      return `${describeWorld(mundo)} — a fila estava vazia, e o agente SORTEOU esta seed.`;
    }

    return pinned === null
      ? `${describeWorld(mundo)} (entrada #${String(escolha.entry.id)} da fila).`
      : `${describeWorld(mundo)} (entrada #${String(escolha.entry.id)}, escolhida a dedo no plano).`;
  }

  /**
   * O mapa escolhido a dedo NÃO vai subir — e por quê.
   *
   * ####  SEM ESTA LINHA A TRAVA NÃO AVISA NINGUÉM  ####
   *
   * O wipe acontece do mesmo jeito: cair para a fila é de
   * propósito, e um ponteiro velho não pode ser motivo para o
   * servidor não zerar. Mas a entrada apontada continua na fila,
   * `ready`, e sem nenhum registro de por que não foi ela — o
   * admin marcaria a compatibilidade do `.map` se soubesse que é
   * isso que falta. É para ele saber que a trava existe
   * (Docs\16 §9.1).
   *
   * O motivo vem de `pinnedRejection`, escrito em cima do MESMO
   * `usableForWipe` que recusou a entrada: o log não pode explicar
   * uma decisão diferente da que foi tomada.
   */
  #avisarPonteiroRecusado(request: WipeRunRequest, plan: WipePlan, forced: boolean): void {
    if (plan.mapPoolId === null) {
      request.operation.log(
        '[wipe] o plano diz "mapa escolhido a dedo" e não aponta entrada nenhuma: o mundo sai da fila.',
      );

      return;
    }

    const alvo = this.#deps.mapPool.get(request.serverId, plan.mapPoolId);
    const motivo = pinnedRejection(alvo, forced) ?? 'ela não serve para este wipe';

    request.operation.log(
      `[wipe] a entrada #${String(plan.mapPoolId)}, escolhida a dedo no plano, NÃO vai subir: ` +
        `${motivo}. O mundo sai da fila, e a entrada continua lá.`,
    );
  }

  /**
   * `mapSource: 'keep'`: o mundo NÃO muda.
   *
   * ####  NEM A FILA, NEM O `.ini`  ####
   *
   * Nada de `takeForWipe` — consumir uma entrada aqui queimaria o
   * mundo do wipe SEGUINTE por um wipe que nem ia usá-lo. E nada
   * de `updateSettings`: o patch normal grava `levelUrl` sempre,
   * inclusive vazia, e num servidor de mapa custom isso APAGARIA o
   * `.map` que o plano mandou manter. O que zera é o save, e o
   * passo `apagar` já o levou.
   *
   * O mundo é gravado em `map_after` do mesmo jeito, e por dois
   * motivos: é a marca de idempotência que a retomada lê, e é o
   * que o chat e a tela anunciam de `configurar` em diante — sem
   * ela as duas voltariam a mostrar a cabeça da fila, que este
   * wipe não tocou.
   */
  #manterMundo(request: WipeRunRequest, run: WipeRunRecord): string {
    const { serverId } = request;
    const config = this.#deps.servers.configOf(serverId);

    const world: WipeWorld =
      config === null
        ? // O servidor sumiu do agente entre o começo e agora: o
          // retrato tirado na criação da execução é o que resta, e
          // ele é deste mesmo mundo.
          (run.mapBefore ?? { level: null, seed: null, worldSize: null })
        : {
            level: config.level,
            seed: String(config.seed),
            worldSize: config.worldSize,
            levelUrl: config.levelUrl === '' ? null : config.levelUrl,
            mapPoolId: null,
            drawn: false,
          };

    this.#deps.runs.update(serverId, request.runId, { mapAfter: world });

    return `o plano manda MANTER o mundo: ${describeWorld(world)} continua, e a fila não foi tocada.`;
  }

  /** Sobe, e espera o RCON responder. "Subiu" é o RCON. */
  async #subir(request: WipeRunRequest): Promise<string> {
    if (await request.control.isRunning()) {
      return 'o servidor já estava no ar.';
    }

    await request.control.start();

    return request.control.rconConnected
      ? 'no ar, e o RCON respondeu.'
      : 'processo no ar; o RCON ainda não respondeu (mapa grande gerando, provavelmente).';
  }

  /**
   * O mundo novo existe. Registrar, ressincronizar, anunciar.
   *
   * ####  NADA AQUI DERRUBA O WIPE  ####
   *
   * O mundo já nasceu. Uma ressincronização de VIP que falha é uma
   * pendência; desfazer um wipe por causa dela é impossível — e
   * marcar a execução como falha faria a tela oferecer "retomar"
   * para uma coisa que já terminou.
   */
  async #posWipe(
    request: WipeRunRequest,
    run: WipeRunRecord,
    exec: WipeExecSettings,
  ): Promise<string> {
    const { serverId } = request;
    const notes: string[] = [];

    // ####  ESQUECER É O QUE FAZ O RESTO FUNCIONAR  ####
    //
    // O `WipeClock` cacheia a hora do wipe por meia hora. Sem este
    // esquecimento, o bloqueio pós-wipe dos kits continuaria
    // liberando com base no mundo ANTERIOR por até trinta minutos
    // depois de o novo subir.
    this.#deps.world.forget(serverId);

    const saveCreatedAfter = await this.#deps.world.saveCreatedAt(serverId);

    if (saveCreatedAfter === null) {
      notes.push('não deu para ler a hora do mundo novo (RCON fora)');
    } else {
      this.#deps.runs.update(serverId, request.runId, { saveCreatedAfter });

      const world = this.#deps.runs.get(serverId, request.runId)?.mapAfter ?? run.mapAfter;

      this.#deps.wipes.record(serverId, {
        saveCreatedAt: saveCreatedAfter,
        level: world?.level ?? null,
        seed: world?.seed ?? null,
        worldSize: world?.worldSize ?? null,
        wipeRunId: request.runId,
      });

      if (run.saveCreatedBefore !== null && run.saveCreatedBefore === saveCreatedAfter) {
        // A conferência independente, e a razão de a tabela `wipes`
        // existir. Ver o cabeçalho de db/wipes-repository.ts.
        notes.push(
          'ATENÇÃO: o SaveCreatedTime não mudou. A execução terminou, mas o mundo pode ser o ' +
            'mesmo de antes — confira a pasta do save',
        );
      }
    }

    if (exec.post.resync && this.#deps.resync !== undefined) {
      try {
        await this.#deps.resync(serverId);
        notes.push('VIP, loadouts e kits ressincronizados');
      } catch (error) {
        notes.push(`a ressincronização falhou (${toError(error).message})`);
      }
    }

    if (exec.post.announce) {
      try {
        await this.#say(request, exec.post.announceText, exec.announce);
        notes.push('mundo novo anunciado no chat');
      } catch (error) {
        notes.push(`o anúncio não saiu (${toError(error).message})`);
      }
    }

    // ####  A FILA DE DEVOLUÇÃO DE BLUEPRINTS  ####
    //
    // Uma linha por jogador do snapshot — inclusive quem não é VIP
    // hoje. Quem recebe de verdade é decidido na ENTREGA, contra o
    // VIP vigente naquele instante: quem comprar VIP amanhã ainda
    // encontra a linha dele aqui.
    if (run.bpPolicy === 'wipe_except_vip') {
      notes.push(this.#enqueueBlueprints(request, run));
    }

    return notes.length === 0 ? 'nada a fazer depois de subir.' : `${notes.join('; ')}.`;
  }

  // ----------------------------------------------------------
  //  §4  Auxiliares
  // ----------------------------------------------------------

  /**
   * Guarda o que cada jogador sabe, antes de o mundo ser apagado.
   *
   * ####  ELE NUNCA DERRUBA O WIPE  ####
   *
   * O `catch` é aqui, e é ele que cumpre a regra: falhar o
   * snapshot vira um AVISO no log, a política daquele run cai na
   * prática para `wipe` (o `pos-wipe` não vai achar snapshot para
   * enfileirar), e o mundo zera na hora marcada. Um wipe travado
   * porque o export não respondeu é pior que um wipe sem
   * devolução.
   *
   * Só roda com `wipe_except_vip`: nas outras duas políticas não
   * há o que devolver, e gastar minutos lendo o persistance de uma
   * base inteira com os jogadores esperando seria trabalho jogado
   * fora.
   */
  async #snapshotBlueprints(request: WipeRunRequest, run: WipeRunRecord): Promise<void> {
    if (run.bpPolicy !== 'wipe_except_vip') {
      return;
    }

    const { operation } = request;

    if (this.#deps.blueprints === undefined) {
      operation.log(
        '[wipe] ATENÇÃO: este wipe é "wipe_except_vip" e não há módulo de blueprints neste ' +
          'agente. Ninguém vai receber os blueprints de volta — na prática, a política deste ' +
          'run é "wipe".',
      );

      return;
    }

    try {
      const result = await this.#deps.blueprints.snapshot({
        serverId: request.serverId,
        wipeRunId: request.runId,
      });

      operation.log(
        `[wipe] blueprints guardados: ${String(result.players)} jogador(es), ` +
          `${String(result.items)} item(ns). A devolução é enfileirada no pós-wipe.`,
      );
    } catch (error) {
      // Alto e bom som, e no log da execução: é a única pista de
      // que aquele wipe zerou o conhecimento de quem pagou.
      operation.log(
        `[wipe] ATENÇÃO: o snapshot de blueprints FALHOU (${toError(error).message}). O wipe ` +
          'continua, e a política deste run cai para "wipe": ninguém vai receber blueprint de ' +
          'volta.',
      );

      this.#deps.logger?.error(
        { server: request.serverId, run: request.runId, err: toError(error) },
        'o snapshot de blueprints falhou; o wipe segue com a política caída para "wipe"',
      );
    }
  }

  /** Abre a fila de devolução. Nunca lança: o mundo já nasceu. */
  #enqueueBlueprints(request: WipeRunRequest, run: WipeRunRecord): string {
    if (this.#deps.blueprints === undefined) {
      return 'sem módulo de blueprints: nada a devolver';
    }

    try {
      const queued = this.#deps.blueprints.enqueue({
        serverId: request.serverId,
        wipeRunId: request.runId,
        wipeAt: run.wipeAt,
      });

      return queued === 0
        ? 'nenhuma devolução de blueprint enfileirada (o snapshot não existe — a política deste ' +
            'run caiu para "wipe")'
        : `${String(queued)} devolução(ões) de blueprint na fila`;
    } catch (error) {
      return `a fila de devolução de blueprints não abriu (${toError(error).message})`;
    }
  }

  /**
   * Espera até um instante, acordando de trinta em trinta
   * segundos.
   *
   * O sono é picado de propósito: um `setTimeout` de 24 horas não
   * reage ao cancelamento com a rapidez que a tela promete, e não
   * sobrevive a uma máquina que dorme.
   */
  async #waitUntil(at: number, operation: Operation): Promise<void> {
    while (Date.now() < at) {
      if (operation.cancelled) {
        return;
      }

      await delay(Math.min(ANNOUNCE_TICK_MS, at - Date.now()), operation.signal);
    }
  }

  /** Uma fala, pelo Broadcaster. É o único caminho. Ver o cabeçalho. */
  async #say(
    request: WipeRunRequest,
    text: string,
    look: WipeAnnounceSettings,
  ): Promise<void> {
    if (this.#deps.broadcaster === undefined) {
      request.operation.log(`[chat] (sem transporte de chat neste agente) ${text}`);
      return;
    }

    const result = await this.#deps.broadcaster.send({
      serverId: request.serverId,
      text,
      tag: look.tag,
      tagColor: look.tagColor,
      color: look.color,
      size: look.size,
    });

    request.operation.log(`[chat] (${result.via}) ${text}`);
  }

  /**
   * O plano da agenda acompanha a execução.
   *
   * Sem isto, um wipe executado continuaria `planned` para sempre:
   * o relógio o dispararia de novo na volta seguinte, e o servidor
   * zeraria duas vezes.
   */
  #markPlan(run: WipeRunRecord, status: 'done' | 'failed'): void {
    if (run.planId === null) {
      return;
    }

    try {
      this.#deps.schedule.markPlanStatus(run.serverId, run.planId, status);
    } catch (error) {
      this.#deps.logger?.warn(
        { server: run.serverId, plan: run.planId, err: toError(error) },
        'não consegui marcar o plano de wipe como executado',
      );
    }
  }
}

// ------------------------------------------------------------
//  As marcas do passo `avisar`, dentro da mensagem dele
// ------------------------------------------------------------

const SENT_PREFIX = 'avisos enviados: ';

export function formatSentOffsets(sent: ReadonlySet<number>): string {
  return `${SENT_PREFIX}${[...sent].sort((a, b) => b - a).join(',')}`;
}

export function parseSentOffsets(message: string | null): readonly number[] {
  if (message === null || !message.startsWith(SENT_PREFIX)) {
    return [];
  }

  return message
    .slice(SENT_PREFIX.length)
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function stepMessageOf(run: WipeRunRecord, step: WipeRunStep): string | null {
  return run.steps.find((entry) => entry.step === step)?.message ?? null;
}

function describeWorld(world: WipeWorld): string {
  if (world.levelUrl !== null && world.levelUrl !== undefined && world.levelUrl !== '') {
    return `mapa custom (${world.levelUrl})`;
  }

  const size = world.worldSize === null ? '' : ` · ${String(world.worldSize)}`;
  const seed = world.seed === null ? '' : ` · seed ${world.seed}`;

  return `${world.level ?? 'Procedural Map'}${size}${seed}`;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));

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
