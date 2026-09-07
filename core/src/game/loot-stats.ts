// ============================================================
//  loot-stats.ts  -  traz de volta o que a regra de loot contou.
//
//  ####  SEM ISTO O MODO `measuring` NÃO SERVE PARA NADA  ####
//
//  Em `measuring` a regra CONTA quantas vezes teria disparado e não
//  cria item nenhum. Esse é o ponto inteiro da fatia: trocar a
//  estimativa de 1.000–5.000 containers/dia do `Docs/CustomItem/04`
//  §6.3 por um número medido. Se a contagem ficar dentro do plugin,
//  ela morre no primeiro `oxide.reload` e ninguém nunca vê o
//  denominador.
//
//  ------------------------------------------------------------
//  ####  POR QUE PERGUNTAR, E NÃO DEIXAR O PLUGIN GRITAR  ####
//
//  O `OrigemZItems` já grita `#OZSTAT#` no console para os pontos,
//  e seria tentador acrescentar um marcador para a contagem. Não é
//  o certo aqui, por duas razões:
//
//   1. **o que se transporta é um ACUMULADO, não um evento.** Cada
//      leitura devolve o total do dia inteiro. Um marcador por
//      sorteio daria milhares de linhas de console por dia para
//      transportar um número que cabe numa;
//   2. **gritar exige segredo.** O canal do console é público — o
//      agente lê TODA linha, e por isso o `#OZSTAT#` precisa de um
//      segredo para um jogador não se premiar digitando o marcador
//      no chat. Perguntar por RCON não tem essa exposição: quem
//      responde é o plugin, e ninguém forja uma resposta de RCON.
//
//  ------------------------------------------------------------
//  ####  E POR QUE UM RELÓGIO PRÓPRIO, E NÃO O DE 60 s QUE EXISTE  ####
//
//  O `rankings/collector.ts` já dá uma volta por minuto — mas ele
//  fala com o `OrigemZPlayer`, e a rodada dele é uma transação que
//  grava estatística de jogador e CONFIRMA com `ack`. Enfiar loot
//  ali faria uma falha de loot derrubar a coleta do ranking, e
//  faria a leitura de um contador herdar a semântica de confirmação
//  de uma fila — que é justamente a que ela NÃO tem.
//
//  E o `rankings/stat-events.ts`, que fala com este mesmo plugin,
//  varre de 5 em 5 minutos e é uma fila com `ack` e idempotência
//  por evento. Contador não é fila.
//
//  Este relógio é 20 linhas, custa um comando por servidor por
//  minuto — o mesmo custo do coletor de ranking — e falha sozinho.
//
//  ------------------------------------------------------------
//  ####  LER NÃO CONSOME  ####
//
//  O plugin NÃO zera o contador quando responde, e o agente
//  SOBRESCREVE a linha do dia em vez de somar. As duas metades da
//  mesma escolha:
//
//    - uma leitura perdida se conserta sozinha na volta seguinte,
//      porque o número continua lá;
//    - duas leituras do mesmo estado dão o mesmo resultado, e com
//      um relógio de 60 s isso é o caso NORMAL.
//
//  É o oposto da fila de pontos do `OrigemZItems`, e de propósito:
//  lá o item JÁ FOI DESTRUÍDO e o que se perde não volta. Aqui o
//  que se perderia é uma contagem que o plugin ainda tem.
//
//  ####  O `day` VEM PRONTO DO JOGO  ####
//
//  E não é recalculado aqui. Quem aplica o teto diário é o plugin,
//  com o relógio dele: um teto que vira à meia-noite de um fuso e
//  um gráfico que vira à de outro seriam duas verdades sobre o
//  mesmo dia, e a pergunta "por que o teto de 3 rendeu 4?" não
//  teria resposta.
// ============================================================

import { z } from 'zod';

import type { LootRuleHitInput, LootRulesRepository } from '../db/loot-rules-repository.js';
import { LOOT_RULE_MODES } from '../db/loot-rules-repository.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import { firstJsonLine } from './plugin-contract.js';

/** `origemz.loot.stats` — o que cada regra contou, por dia. */
export const LOOT_STATS_COMMAND = 'origemz.loot.stats';

/**
 * De quanto em quanto tempo perguntar.
 *
 * O mesmo minuto do coletor de ranking, e pela mesma razão: um
 * comando por servidor por minuto é ruído nenhum, e o atraso máximo
 * de um número que só serve para calibrar chance é irrelevante.
 */
export const LOOT_STATS_INTERVAL_MS = 60_000;

/**
 * O dia, como o plugin o escreve.
 *
 * `YYYY-MM-DD` e nada além. Conferir a FORMA aqui é o que impede
 * uma resposta estranha de virar uma coluna `day` com lixo, que
 * depois apareceria no gráfico como um dia que nunca existiu.
 */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'O dia é `YYYY-MM-DD`.');

/**
 * Uma linha de contagem.
 *
 * Os quatro números são inteiros não-negativos: são contadores, e
 * um negativo aqui seria plugin com defeito, não dado.
 */
const statSchema = z.object({
  rule: z.string().min(1).max(120),
  day: daySchema,
  mode: z.enum(LOOT_RULE_MODES),
  rolls: z.number().int().min(0),
  hits: z.number().int().min(0),
  spawned: z.number().int().min(0),
  blocked: z.number().int().min(0),
});

const responseSchema = z.object({
  ok: z.literal(true),
  stats: z.array(statSchema),
});

export interface LootStatsServers {
  ids(): readonly string[];
  /** `null` = o agente não está cuidando deste servidor. */
  rconOf(serverId: string): OpsRcon | null;
}

export interface LootStatsCollectorDeps {
  readonly repository: LootRulesRepository;
  readonly servers: LootStatsServers;
  readonly logger: Logger;
  /** Só os testes passam. Ver `LOOT_STATS_INTERVAL_MS`. */
  readonly intervalMs?: number;
}

export interface LootStatsSweepResult {
  readonly serverId: string;
  /** Quantas linhas de contagem foram gravadas. */
  readonly written: number;
  /** `null` = a leitura aconteceu. Preenchido = por que não. */
  readonly skipped: string | null;
}

export class LootStatsCollector {
  readonly #deps: LootStatsCollectorDeps;

  /** Quem já está sendo lido, para dois relógios não se atropelarem. */
  readonly #reading = new Set<string>();

  /** O relógio. `null` = parado. */
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: LootStatsCollectorDeps) {
    this.#deps = deps;
  }

  /**
   * Lê um servidor. NUNCA lança.
   *
   * Servidor parado, RCON caído, plugin que não conhece o comando:
   * tudo isso é rotina, e nenhum deles pode parar o relógio. O
   * motivo vai no `skipped`.
   */
  async sweep(serverId: string, trigger: string): Promise<LootStatsSweepResult> {
    if (this.#reading.has(serverId)) {
      // Duas leituras simultâneas do mesmo servidor não corrompem
      // nada (a gravação sobrescreve), mas gastariam dois comandos
      // de RCON para chegar ao mesmo número.
      return { serverId, written: 0, skipped: 'já havia uma leitura em curso' };
    }

    const rcon = this.#deps.servers.rconOf(serverId);

    if (rcon === null || !rcon.isConnected) {
      return { serverId, written: 0, skipped: 'o RCON está fora do ar' };
    }

    this.#reading.add(serverId);

    try {
      const raw = await rcon.send(LOOT_STATS_COMMAND);
      const parsed = responseSchema.safeParse(firstJsonLine(raw));

      if (!parsed.success) {
        // ####  ISTO É QUASE SEMPRE PLUGIN DESATUALIZADO  ####
        //
        // Um `OrigemZItems` anterior a esta fatia responde "Command
        // not found", que não é JSON. É `debug`, e não `warn`, de
        // propósito: com o relógio de 60 s um `warn` daria 1.440
        // linhas iguais por dia por servidor, e log que sempre toca
        // é log que se aprende a ignorar. Quem procura o motivo
        // acha na resposta abaixo.
        this.#deps.logger.debug(
          { server: serverId, trigger, response: raw.slice(0, 200) },
          'o plugin não devolveu a contagem de loot; ele está atualizado ali?',
        );

        return { serverId, written: 0, skipped: 'o plugin não respondeu a contagem' };
      }

      const entries: LootRuleHitInput[] = parsed.data.stats.map((stat) => ({
        ruleId: stat.rule,
        serverId,
        day: stat.day,
        mode: stat.mode,
        rolls: stat.rolls,
        hits: stat.hits,
        spawned: stat.spawned,
        blocked: stat.blocked,
      }));

      const written = this.#deps.repository.recordHits(entries);

      if (written > 0) {
        this.#deps.logger.debug(
          { server: serverId, written, trigger },
          'contagem das regras de loot atualizada',
        );
      }

      return { serverId, written, skipped: null };
    } catch (error) {
      this.#deps.logger.warn(
        { server: serverId, trigger, err: toError(error) },
        'não consegui ler a contagem das regras de loot',
      );

      return { serverId, written: 0, skipped: toError(error).message };
    } finally {
      this.#reading.delete(serverId);
    }
  }

  /** Todos os servidores. Um que falha não segura os outros. */
  async sweepAll(trigger: string): Promise<readonly LootStatsSweepResult[]> {
    const results: LootStatsSweepResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.sweep(serverId, trigger));
    }

    return results;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    const timer = setInterval(() => {
      void this.sweepAll('relógio').catch((error: unknown) => {
        // Não deveria acontecer: `sweep` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um timer, onde uma
        // Promise rejeitada não teria quem a pegasse.
        this.#deps.logger.error(
          { err: toError(error) },
          'a leitura da contagem de loot lançou',
        );
      });
    }, this.#deps.intervalMs ?? LOOT_STATS_INTERVAL_MS);

    // Como todo relógio deste projeto: uma leitura pendente não pode
    // segurar o processo vivo no desligamento.
    timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer === null) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = null;
  }
}
