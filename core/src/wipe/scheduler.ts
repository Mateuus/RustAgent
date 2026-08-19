// ============================================================
//  scheduler.ts  -  o relógio que dispara o plano vencido.
//
//  ####  ELE MORA NO AGENTE, E NÃO NUM PLUGIN  ####
//
//  No dia do wipe forçado o servidor é ATUALIZADO, e o Oxide pode
//  ainda não ter build compatível. Nessa janela nenhum plugin
//  carrega — ou seja, um scheduler dentro do jogo não roda
//  exatamente no dia em que o wipe é obrigatório. O agente é um
//  processo separado: ele funciona com o Oxide quebrado, com o
//  servidor fora do ar e durante o download do SteamCMD. Ver
//  Docs\16 §6.
//
//  ------------------------------------------------------------
//  ####  ELE DISPARA ANTES DA HORA, DE PROPÓSITO  ####
//
//  Um wipe às 16:00 com avisos de 24 h, 6 h e 1 h não pode
//  começar às 16:00: o passo `avisar` precisa estar rodando desde
//  as 16:00 do dia anterior para a primeira fala sair. Então a
//  execução nasce em `scheduledAt - maiorOffset`, e o passo
//  `avisar` é quem espera — e é ele quem sabe até que hora.
//
//  ------------------------------------------------------------
//  ####  O TICK NUNCA LANÇA  ####
//
//  Rodando num `setInterval`, uma exceção sem dono mata o laço, e
//  a partir dali nenhum wipe agendado acontece — em SILÊNCIO, que
//  é o pior desfecho possível para um relógio. Cada servidor é
//  tratado dentro do seu próprio `try`: um servidor com problema
//  não pode calar os outros.
// ============================================================

import type { WipeExecSettings } from '../db/wipe-runs-repository.js';
import type { WipeScheduleRepository } from '../db/wipe-schedule-repository.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';

/** De quanto em quanto tempo ele acorda. */
export const WIPE_TICK_MS = 30_000;

/**
 * Quanto o relógio olha para a frente.
 *
 * É a folga por cima do maior offset de aviso: sem ela, um wipe
 * cujo maior aviso é de 24 h só entraria em execução no tick
 * seguinte ao instante exato, e o primeiro aviso sairia atrasado
 * pelos trinta segundos do laço.
 */
export const WIPE_LOOKAHEAD_SLACK_MS = 2 * WIPE_TICK_MS;

/** O que o relógio precisa saber fazer para disparar um wipe. */
export interface WipeLauncher {
  /**
   * Começa a execução daquele plano.
   *
   * @throws quando a pré-condição recusa (servidor em outra
   * operação, disco cheio). O relógio registra e tenta de novo no
   * tick seguinte — o plano continua `planned`.
   */
  launch(input: { readonly serverId: string; readonly planId: number }): Promise<void>;
}

/**
 * O recorte de `WipeRunsRepository` que o relógio usa.
 *
 * Só a configuração da execução, e por um motivo: é dela que sai a
 * FOLGA (o maior offset de aviso), que é a única coisa que este
 * arquivo precisa saber sobre como o wipe é executado. Uma
 * interface em vez da classe inteira é também o que deixa o teste
 * provar que um servidor que ESTOURA aqui não cala os outros.
 */
export interface WipeExecSettingsReader {
  getExecSettings(serverId: string): WipeExecSettings;
}

export interface WipeSchedulerDeps {
  readonly schedule: WipeScheduleRepository;
  readonly runs: WipeExecSettingsReader;
  readonly launcher: WipeLauncher;
  /** Os servidores deste agente, lidos a cada tick. */
  readonly servers: () => readonly string[];
  readonly logger?: Logger | undefined;
  readonly now?: (() => number) | undefined;
  readonly intervalMs?: number | undefined;
}

export class WipeScheduler {
  readonly #deps: WipeSchedulerDeps;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  /**
   * Os planos que já foram entregues ao lançador nesta sessão.
   *
   * O relógio acorda de trinta em trinta segundos, e a execução
   * pode levar horas (os avisos). Sem esta lembrança, o mesmo
   * plano seria disparado a cada volta até o `status` dele mudar
   * — e ele só muda no FIM da execução.
   */
  readonly #launched = new Set<string>();
  #ticking = false;

  constructor(deps: WipeSchedulerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#deps.intervalMs ?? WIPE_TICK_MS);

    // `unref` para o relógio não segurar o processo de pé no
    // desligamento: um agente que não morre no `pm2 stop` é um
    // agente que alguém mata à força, e aí um wipe em curso perde
    // a chance de gravar em que passo estava.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma volta. NUNCA LANÇA.
   *
   * Exposta para o teste chamar direto, sem esperar trinta
   * segundos de relógio de verdade.
   */
  async tick(): Promise<void> {
    if (this.#ticking) {
      // Uma volta que demora mais que o intervalo não pode ser
      // atropelada pela seguinte: duas voltas em paralelo veriam o
      // mesmo plano `planned` e o disparariam duas vezes.
      return;
    }

    this.#ticking = true;

    try {
      for (const serverId of this.#deps.servers()) {
        try {
          await this.#tickServer(serverId);
        } catch (error) {
          // Um servidor com problema não cala os outros, e não
          // mata o laço. Ver o cabeçalho.
          this.#deps.logger?.error(
            { server: serverId, err: toError(error) },
            'o relógio do wipe tropeçou neste servidor',
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #tickServer(serverId: string): Promise<void> {
    const now = this.#now();
    const exec = this.#deps.runs.getExecSettings(serverId);
    const lead = leadTimeMs(exec.announce.offsetsMinutes);
    const horizon = now + lead + WIPE_LOOKAHEAD_SLACK_MS;

    for (const plan of this.#deps.schedule.duePlans(serverId, horizon)) {
      const key = `${serverId}#${String(plan.id)}`;

      if (this.#launched.has(key)) {
        continue;
      }

      this.#launched.add(key);

      this.#deps.logger?.info(
        {
          server: serverId,
          plan: plan.id,
          at: plan.scheduledAt,
          leadMinutes: Math.round(lead / 60_000),
        },
        'o relógio do wipe está disparando um plano',
      );

      try {
        await this.#deps.launcher.launch({ serverId, planId: plan.id });
      } catch (error) {
        // A recusa é normal e temporária: o servidor pode estar
        // instalando, o disco pode estar cheio. Tirar da lembrança
        // é o que faz o tick seguinte tentar de novo — e o plano
        // continua `planned`, então ele não some da agenda.
        this.#launched.delete(key);

        this.#deps.logger?.warn(
          { server: serverId, plan: plan.id, err: toError(error) },
          'o wipe agendado não pôde começar agora; tento de novo no próximo tick',
        );
      }
    }
  }
}

/**
 * Quanto tempo antes da hora a execução precisa começar.
 *
 * É o maior offset de aviso. Sem avisos, é zero — e aí a execução
 * começa na hora marcada, como qualquer um esperaria.
 */
export function leadTimeMs(offsetsMinutes: readonly number[]): number {
  if (offsetsMinutes.length === 0) {
    return 0;
  }

  return Math.max(...offsetsMinutes) * 60_000;
}
