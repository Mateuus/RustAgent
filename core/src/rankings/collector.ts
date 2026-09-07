// ============================================================
//  collector.ts  -  o relógio de 60 s que traz o número do jogo.
//
//  ####  ESTE É O CAMINHO "PULL"  ####
//
//  O ranking tem dois canais, e este é o do LOTE: a cada minuto o
//  agente pergunta ao plugin o que aconteceu, grava numa transação
//  só e CONFIRMA. O outro canal — o marcador `#OZSTAT#` no console
//  — dá o "agora" para o recibo no chat, e mora em
//  `rankings/stat-events.ts`. Os dois carregam o mesmo `eventId`, e
//  quem desempata é a tabela `stat_events`.
//
//  ------------------------------------------------------------
//  ####  A ORDEM DA RODADA NÃO É ARBITRÁRIA  ####
//
//    1. o plugin está de pé?      não → registra e passa adiante
//    2. o mundo mudou?            sim → grava em `wipes`
//    3. as janelas viraram?       `sweepPeriods`
//    4. o tempo online do intervalo
//    5. pagina o `flush` até o fim
//    6. aplica TUDO numa transação só
//    7. `ack` — depois do COMMIT, sempre
//
//  O passo 2 vem antes do 5 porque um lote que chegasse ANTES da
//  virada somaria o minério do mundo velho no período do mundo
//  novo. E o 7 vem depois do 6 porque confirmar antes de gravar
//  troca uma duplicata inofensiva — que o `batchId` recusa em
//  `stat_batches` — por uma perda silenciosa.
//
//  ------------------------------------------------------------
//  ####  O PASSO 2 CONSERTA UM BURACO QUE NÃO É SÓ DO RANKING  ####
//
//  `wipesRepository.record()` tinha UM chamador: o passo `#posWipe`
//  de `wipe/run.ts`. Ou seja: um wipe feito **à mão**, com o agente
//  rodando, não criava linha em `wipes` até a próxima execução
//  passar por ali — e o histórico de mundos do projeto inteiro
//  ficava com um buraco que ninguém via.
//
//  O detector daqui fecha isso. O `WipeClock` já cacheia por meia
//  hora, então o custo por rodada é próximo de zero, e quem ganha
//  não é só o ranking: é a fila de mapas (`recentSeeds`), a
//  conferência independente da execução e a régua pós-wipe dos
//  kits.
//
//  ------------------------------------------------------------
//  ####  `sweep()` NUNCA LANÇA  ####
//
//  Servidor parado, RCON caído, plugin que não compila: tudo isso é
//  rotina. Uma exceção que escapasse pararia a coleta para sempre,
//  em silêncio — o pior jeito de um relógio falhar. O try/catch é
//  POR SERVIDOR, e a volta seguinte tenta de novo.
//
//  Documento: `Docs/Ranking/20-PLANO-E-CONTRATOS.md` §5, §6 e §8.
// ============================================================

import type { ComputedPodium, RankingsRepository } from '../db/rankings-repository.js';
import type { WipesRepository } from '../db/wipes-repository.js';
import { firstJsonLine, PLAYERS_PLUGIN } from '../game/plugin-contract.js';
import {
  STATS_COMMANDS,
  STATS_FLUSH_DEFAULT_LIMIT,
  STATS_NO_BATCH,
  STATS_PAYLOAD_TOO_LARGE,
  buildStatsAckCommand,
  buildStatsFlushCommand,
  statsAckResponseSchema,
  statsFlushResponseSchema,
  type StatsFlushEvent,
  type StatsFlushPage,
  type StatsFlushPlayer,
  type StatsFlushRecord,
} from '../game/stats-contract.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import { sweepPeriods, type PeriodsDeps } from './periods.js';
import type { CoverageStatus } from './service.js';

/** De quanto em quanto tempo o coletor dá uma volta. */
export const DEFAULT_STATS_INTERVAL_MS = 60_000;

/**
 * O plugin que responde ao `flush`.
 *
 * É o MESMO do `origemz.players`, e por isso vem de
 * `plugin-contract.ts` em vez de nascer aqui: dois nomes para o
 * mesmo arquivo divergiriam no dia em que ele fosse renomeado.
 */
export const STATS_PLUGIN_NAME = PLAYERS_PLUGIN;

/** A métrica do tempo de jogo. Ver a migração 034. */
export const TIME_PLAYED_METRIC = 'time.played';

/** O que o coletor precisa saber dos servidores. E nada além. */
export interface StatsCollectorServers {
  ids(): readonly string[];
  /** `null` = o agente não está cuidando deste servidor. */
  rconOf(serverId: string): OpsRcon | null;
}

/** A única coisa que o coletor pergunta ao cadastro de jogadores. */
export interface StatsCollectorPlayers {
  playedSecondsOf(serverId: string): ReadonlyMap<string, number>;
}

/** O mundo configurado, como ele vai para a linha de `wipes`. */
export interface StatsCollectorWorld {
  readonly level: string | null;
  readonly seed: string | null;
  readonly worldSize: number | null;
}

export interface StatsCollectorDeps {
  readonly repository: RankingsRepository;
  readonly wipes: WipesRepository;
  readonly players: StatsCollectorPlayers;
  readonly servers: StatsCollectorServers;
  /**
   * O `OrigemZAgent` está carregado ali?
   *
   * `true` / `false` / `null`, e o `null` importa: ele quer dizer
   * "ainda não perguntei ao Oxide", e nesse caso a rodada TENTA
   * assim mesmo. Tratar "não sei" como "não está carregado" faria
   * o primeiro minuto de cada boot não contar para ninguém.
   */
  readonly pluginLoaded: (serverId: string) => boolean | null;
  /**
   * A hora do mundo, do `serverinfo`. `null` = não deu para saber.
   *
   * `null` NÃO é "não mudou": sem a resposta, a rodada não decide
   * nada sobre wipe e segue para a coleta.
   */
  readonly worldAt: (serverId: string) => Promise<number | null>;
  /** O mundo configurado, para a linha de `wipes`. */
  readonly worldOf?: ((serverId: string) => StatsCollectorWorld | null) | undefined;
  /** A ponte que congela o pódio do K/D. Ver `rankings/service.ts`. */
  readonly computed?: ComputedPodium | undefined;
  /** Zona IANA para os rótulos das janelas. Ausente = a da máquina. */
  readonly timeZone?: string | undefined;
  /**
   * O segredo do canal `#OZSTAT#`, reafirmado a cada `flush`.
   *
   * ####  ELE VIAJA DAQUI PORQUE O `flush` JÁ VIAJA  ####
   *
   * O plugin guarda o segredo só em memória e emite o recorde no
   * console assim que ele acontece — o "agora" do §7.1. Quem
   * confere a linha é o `StatEventsConsumer`, e o valor tem de ser
   * o MESMO dos dois lados: dois sorteios fariam o agente descartar
   * tudo o que o plugin emitisse, e o sintoma seria "o recorde só
   * aparece de minuto em minuto".
   *
   * Ausente NÃO quebra nada: o plugin deixa de empurrar e o recorde
   * chega no lote, que é o caminho garantido.
   */
  readonly secret?: string | undefined;
  readonly logger?: Logger | undefined;
  readonly intervalMs?: number | undefined;
}

/** O que uma rodada de um servidor produziu. */
export interface StatsRoundResult {
  readonly serverId: string;
  readonly status: CoverageStatus;
  /** Um mundo novo apareceu e virou linha em `wipes`. */
  readonly wipeDetected: boolean;
  /** Quantas janelas viraram nesta rodada. */
  readonly rolled: number;
  /** `null` quando não houve lote (plugin fora, RCON fora). */
  readonly batchId: string | null;
  readonly playersApplied: number;
  /** Quantos jogadores ganharam segundos de `time.played`. */
  readonly timePlayers: number;
  /** Páginas que o plugin recusou por tamanho e foram refeitas menores. */
  readonly shrunkPages: number;
  /** `false` = o `batchId` já tinha sido aplicado (o `ack` se perdeu). */
  readonly applied: boolean;
}

/** O lote inteiro, montado a partir das páginas. */
export interface StatsBatchPages {
  readonly batchId: string;
  readonly seq: number;
  readonly players: readonly StatsFlushPlayer[];
  readonly records: readonly StatsFlushRecord[];
  readonly events: readonly StatsFlushEvent[];
  readonly shrunkPages: number;
}

// ------------------------------------------------------------
//  O transporte
// ------------------------------------------------------------

/**
 * Uma página do lote, já conferida contra o contrato.
 *
 * `null` quer dizer "esta página não coube" (`PAYLOAD_TOO_LARGE`),
 * e quem chama reduz o `limit`. Qualquer outra recusa LANÇA — e é
 * de propósito: uma resposta fora do contrato tratada como lista
 * vazia diria "ninguém minerou" no minuto exato em que alguém
 * precisa saber que o plugin caiu.
 */
export async function fetchStatsPage(
  rcon: OpsRcon,
  offset: number,
  limit: number,
  secret?: string,
): Promise<StatsFlushPage | null> {
  const raw = await rcon.send(buildStatsFlushCommand(offset, limit, secret));
  const line = firstJsonLine(raw);

  if (line === null) {
    throw new Error(
      `o servidor respondeu ao ${STATS_COMMANDS.flush} sem nenhuma linha de JSON (veio: ` +
        `${raw.trim().slice(0, 200)}). O OrigemZAgent está carregado neste servidor?`,
    );
  }

  const parsed = statsFlushResponseSchema.safeParse(line);

  if (!parsed.success) {
    throw new Error(
      `a resposta do ${STATS_COMMANDS.flush} não bate com o contrato do plugin: ` +
        JSON.stringify(line).slice(0, 200),
    );
  }

  if (!parsed.data.ok) {
    if (parsed.data.error === STATS_PAYLOAD_TOO_LARGE) {
      return null;
    }

    throw new Error(`o plugin recusou o ${STATS_COMMANDS.flush}: ${parsed.data.error}`);
  }

  return parsed.data;
}

/**
 * Pagina o `flush` até o fim e devolve o lote inteiro.
 *
 * ####  A JANELA ENCOLHE, E O `offset` NÃO ANDA  ####
 *
 * Página recusada por tamanho vira metade do `limit` e o MESMO
 * `offset`: avançar ali pularia jogador em silêncio. Se nem com
 * `limit = 1` couber, o ciclo é abandonado INTEIRO — um lote pela
 * metade que se disfarça de completo seria confirmado, e o resto
 * do minério iria embora sem nada no log.
 *
 * ####  E PÁGINA MENOR QUE O `limit` NÃO É FIM DE LISTA  ####
 *
 * Quem avança é o `limit` que VOLTOU (já normalizado pelo plugin),
 * e o fim é `offset >= count`. Contar pelo tamanho do array
 * pararia na primeira página em que um jogador sem métrica ficou
 * de fora.
 */
export async function collectStatsBatch(
  rcon: OpsRcon,
  startLimit: number = STATS_FLUSH_DEFAULT_LIMIT,
  secret?: string,
): Promise<StatsBatchPages> {
  const players: StatsFlushPlayer[] = [];
  const records: StatsFlushRecord[] = [];
  const events: StatsFlushEvent[] = [];

  let offset = 0;
  let limit = startLimit;
  let total: number | null = null;
  let batchId: string | null = null;
  let seq = 0;
  let shrunkPages = 0;

  while (total === null || offset < total) {
    const page = await fetchStatsPage(rcon, offset, limit, secret);

    if (page === null) {
      if (limit <= 1) {
        throw new Error(
          `a linha na posição ${String(offset)} não cabe sozinha numa resposta do ` +
            `${STATS_COMMANDS.flush}. O ciclo foi abandonado inteiro em vez de aplicar meio ` +
            'lote — o resto seria descartado no `ack` sem ninguém saber.',
        );
      }

      limit = Math.max(1, Math.floor(limit / 2));
      shrunkPages += 1;
      continue;
    }

    if (batchId === null) {
      batchId = page.batchId;
      seq = page.seq;
    } else if (page.batchId !== batchId) {
      // O lote congela no `offset = 0` e só o `ack` o descarta.
      // Trocar de id no meio da paginação significa que alguém
      // confirmou por fora, ou que o plugin recarregou — e as
      // páginas já lidas descrevem outro conjunto.
      throw new Error(
        `o lote trocou no meio da paginação (${batchId} -> ${page.batchId}). A rodada foi ` +
          'abandonada; o lote continua pendente no plugin e volta inteiro na próxima.',
      );
    }

    total = page.count;
    players.push(...page.players);
    records.push(...page.records);
    events.push(...page.events);

    // O `limit` normalizado que VOLTOU, e não o pedido: quem pede
    // 5000 recebe 250, e avançar 5000 pularia linha.
    offset += page.limit;
  }

  return {
    batchId: batchId ?? '',
    seq,
    players,
    records,
    events,
    shrunkPages,
  };
}

// ------------------------------------------------------------
//  O relógio
// ------------------------------------------------------------

export class StatsCollector {
  readonly #deps: StatsCollectorDeps;
  readonly #intervalMs: number;

  /**
   * A marca d'água do tempo online: servidor -> (steamId -> segundos).
   *
   * ####  ELA MORA NA MEMÓRIA, E ISSO É UMA DECISÃO  ####
   *
   * `player_servers.played_seconds` é acumulado desde sempre e não
   * sabe o que é período; o que o ranking quer é a DIFERENÇA entre
   * duas rodadas. Guardar essa marca numa tabela seria uma segunda
   * verdade sobre um número que já existe — e ela vale 60 s.
   *
   * O preço é declarado: ao reiniciar, a primeira rodada de cada
   * servidor só SEMEIA a marca e soma zero.
   */
  readonly #marks = new Map<string, Map<string, number>>();

  /** Como cada servidor respondeu na última rodada. Ver §9.2. */
  readonly #status = new Map<string, CoverageStatus>();

  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(deps: StatsCollectorDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DEFAULT_STATS_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    // Sem `unref`, este relógio sozinho seguraria o processo de pé
    // depois de tudo o mais ter parado.
    this.#timer.unref();

    this.#deps.logger?.info(
      { intervalSeconds: Math.round(this.#intervalMs / 1000) },
      'coletor do ranking ligado',
    );

    // A primeira volta é AGORA, e não daqui a um minuto: sem ela, um
    // agente que sobe logo depois de um wipe manual passaria o
    // primeiro minuto contando no período do mundo antigo.
    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Uma passada por todos os servidores. NUNCA lança. */
  async sweep(): Promise<void> {
    if (this.#running) {
      // Uma rodada por vez. Duas rodadas concorrentes pediriam dois
      // `flush offset=0` e a segunda receberia o lote da primeira,
      // aplicando-o duas vezes — o `batchId` seguraria, mas o log
      // ficaria impossível de ler.
      return;
    }

    this.#running = true;

    try {
      for (const serverId of this.#deps.servers.ids()) {
        try {
          await this.collect(serverId);
        } catch (error) {
          this.#status.set(serverId, 'no-answer');
          this.#deps.logger?.warn(
            { server: serverId, err: toError(error) },
            'a coleta de estatística deste servidor falhou nesta rodada',
          );
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * Uma rodada de UM servidor, nos sete passos do §6.4.
   *
   * @throws quando o RCON responde fora do contrato. Quem chama é o
   * `sweep`, que transforma isso num aviso por servidor.
   */
  async collect(serverId: string, now: number = Date.now()): Promise<StatsRoundResult> {
    const rcon = this.#deps.servers.rconOf(serverId);

    // 1. dá para perguntar?
    if (rcon === null || !rcon.isConnected) {
      return this.#skip(serverId, 'no-answer');
    }

    if (this.#deps.pluginLoaded(serverId) === false) {
      // ####  ISTO NÃO É ERRO, E PRECISA APARECER NA TELA  ####
      //
      // Um servidor sem o plugin não tem estatística — e "sem
      // dados" é diferente de "zero". O `coverage` do §9.2 é quem
      // conta essa diferença; aqui a rodada só registra e passa ao
      // próximo.
      this.#deps.logger?.debug(
        { server: serverId },
        'o OrigemZAgent não está carregado aqui; a coleta pula este servidor',
      );

      return this.#skip(serverId, 'not-loaded');
    }

    // 2. o mundo mudou?
    const world = await this.#detectWipe(serverId, now);

    // 3. as janelas.
    const swept = sweepPeriods(this.#periodsDeps(), {
      serverId,
      now,
      wipeDetected: world.detected,
      wipeId: world.wipeId,
      // Um wipe descoberto por aqui não tem execução: é o feito à
      // mão. `null` cai na configuração do servidor, que é
      // exatamente o desenho — a âncora é o mundo, não o painel.
      wipeRunId: null,
    });

    // 4. o tempo online do intervalo.
    const played = this.#playedRound(serverId);

    // 5. o lote — e, de carona, o segredo do canal do "agora".
    const batch = await collectStatsBatch(rcon, STATS_FLUSH_DEFAULT_LIMIT, this.#deps.secret);

    // 6. tudo numa transação só.
    //
    // ####  O LOTE VAZIO TAMBÉM É APLICADO  ####
    //
    // Ele não escreve contador nenhum — só a linha de
    // `stat_batches`. E é ela que o `coverage` do §9.2 lê como
    // BATIMENTO: `lastBatchAt` é "o plugin respondeu na última
    // rodada", e sem a linha um servidor tranquilo de madrugada
    // apareceria na tela como coleta parada.
    //
    // O preço é uma linha por minuto por servidor, e ele é
    // declarado: quem for pôr retenção em `stat_batches` um dia
    // precisa saber que a tabela é log de rodada, e não só de
    // lote com conteúdo.
    const merged = mergePlayers(batch.players, played.deltas);

    const result =
      batch.batchId === ''
        ? null
        : this.#deps.repository.applyBatch(
            {
              serverId,
              batchId: batch.batchId,
              seq: batch.seq,
              players: merged,
              records: batch.records.map((record) => ({
                steamId: record.steamId,
                name: record.name ?? null,
                metric: record.metric,
                value: record.value,
                at: record.at,
                // O suspeito ATRAVESSA e é gravado: apagá-lo aqui
                // perderia o rastro da fraude, e é o `status` que o
                // mantém fora do pódio (§2.3).
                status: record.status,
                ...(record.detail === undefined ? {} : { detail: record.detail }),
              })),
              events: batch.events.map((event) => ({
                eventId: event.eventId,
                steamId: event.steamId,
                name: event.name ?? null,
                metric: event.metric,
                amount: event.amount,
                source: event.source ?? null,
                at: event.at,
              })),
              // As janelas que o passo 3 acabou de garantir abertas.
              // Passá-las evita que o repositório as procure de novo
              // dentro da transação — e garante que o lote caia
              // exatamente nas janelas que a rodada decidiu.
              periodIds: swept.open.map((period) => period.id),
              seasonMode: swept.settings.seasonMode,
            },
            now,
          );

    // ####  A MARCA SÓ ANDA QUANDO A ESCRITA ACONTECEU  ####
    //
    // Se o lote já tinha sido aplicado (o `ack` anterior se
    // perdeu), o `applyBatch` não grava NADA — inclusive os
    // segundos deste intervalo. Adiantar a marca ali perderia esse
    // tempo para sempre, e ninguém desconfiaria: o número só
    // ficaria menor do que devia.
    if (played.deltas.size === 0 || result?.applied === true) {
      this.#marks.set(serverId, played.current);
    }

    // 7. o `ack`, depois do COMMIT — sempre.
    await this.#ack(serverId, rcon, batch.batchId);

    this.#status.set(serverId, 'ok');

    return {
      serverId,
      status: 'ok',
      wipeDetected: world.detected,
      rolled: swept.rolled.length,
      batchId: batch.batchId,
      playersApplied: merged.length,
      timePlayers: played.deltas.size,
      shrunkPages: batch.shrunkPages,
      applied: result?.applied ?? false,
    };
  }

  /**
   * A virada das janelas de um wipe que o AGENTE executou.
   *
   * Chamada pelo passo `#posWipe` de `wipe/run.ts`, logo depois do
   * `wipes.record()` que já existia ali. É por aqui que a decisão
   * de três estados de `wipe_runs.open_ranking_season` entra na
   * conta — o coletor sozinho nunca a veria, porque o wipe dele é o
   * feito à mão.
   */
  rollOnWipe(input: {
    readonly serverId: string;
    readonly wipeId: number | null;
    readonly wipeRunId: number | null;
    readonly now?: number;
  }): void {
    if (this.#alreadyTurnedFor(input.serverId, input.wipeId)) {
      this.#deps.logger?.debug(
        { server: input.serverId, wipeId: input.wipeId },
        'as janelas do ranking já tinham virado neste mundo; nada a fazer',
      );

      return;
    }

    sweepPeriods(this.#periodsDeps(), {
      serverId: input.serverId,
      ...(input.now === undefined ? {} : { now: input.now }),
      wipeDetected: true,
      wipeId: input.wipeId,
      wipeRunId: input.wipeRunId,
    });
  }

  /**
   * Como aquele servidor respondeu na última rodada. `null` = nunca
   * rodou.
   *
   * ####  ISTO NÃO É O `coverage` DA API  ####
   *
   * O `coverage` do §9.2 é montado em `index.ts`, a partir de um
   * tripé mais forte que este — o Oxide, o acervo e a idade do
   * último lote. Aqui é só a memória da última volta, para o log e
   * para quem quiser saber se a coleta chegou a acontecer.
   */
  statusOf(serverId: string): CoverageStatus | null {
    return this.#status.get(serverId) ?? null;
  }

  // ----------------------------------------------------------
  //  Privados
  // ----------------------------------------------------------

  #periodsDeps(): PeriodsDeps {
    return {
      repository: this.#deps.repository,
      ...(this.#deps.computed === undefined ? {} : { computed: this.#deps.computed }),
      ...(this.#deps.timeZone === undefined ? {} : { timeZone: this.#deps.timeZone }),
    };
  }

  #skip(serverId: string, status: CoverageStatus): StatsRoundResult {
    this.#status.set(serverId, status);

    return {
      serverId,
      status,
      wipeDetected: false,
      rolled: 0,
      batchId: null,
      playersApplied: 0,
      timePlayers: 0,
      shrunkPages: 0,
      applied: false,
    };
  }

  /**
   * O mundo mudou? E, se mudou, grava a linha.
   *
   * ####  "MUNDO NOVO" E "PRIMEIRO MUNDO VISTO" SÃO DIFERENTES  ####
   *
   * Quando `wipes` ainda não tem linha nenhuma daquele servidor, a
   * divergência não é um wipe: é o agente aprendendo em que mundo
   * ele está. A linha é gravada (senão o histórico nasceria com um
   * buraco), mas as janelas NÃO viram — virá-las fecharia, no
   * primeiro sweep de cada instalação, um período que tinha
   * acabado de abrir.
   */
  async #detectWipe(
    serverId: string,
    now: number,
  ): Promise<{ readonly detected: boolean; readonly wipeId: number | null }> {
    let saveCreatedAt: number | null;

    try {
      saveCreatedAt = await this.#deps.worldAt(serverId);
    } catch (error) {
      // Não saber a hora do mundo não pode custar a coleta do
      // minuto: sem ela a rodada segue, e a detecção tenta de novo
      // na volta seguinte.
      this.#deps.logger?.debug(
        { server: serverId, err: toError(error) },
        'não consegui ler a hora do mundo; a rodada segue sem decidir sobre wipe',
      );

      return { detected: false, wipeId: null };
    }

    if (saveCreatedAt === null) {
      return { detected: false, wipeId: null };
    }

    const latest = this.#deps.wipes.latest(serverId);
    const known = latest?.saveCreatedAt ?? null;

    if (known === saveCreatedAt) {
      return { detected: false, wipeId: latest?.id ?? null };
    }

    const world = this.#deps.worldOf?.(serverId) ?? null;

    const recorded = this.#deps.wipes.record(
      serverId,
      {
        saveCreatedAt,
        level: world?.level ?? null,
        seed: world?.seed ?? null,
        worldSize: world?.worldSize ?? null,
        // Um wipe descoberto aqui não tem execução — é o feito à
        // mão. `null` significa isso, e não "execução número zero".
        wipeRunId: null,
      },
      now,
    );

    if (known === null) {
      this.#deps.logger?.info(
        { server: serverId, saveCreatedAt },
        'primeiro mundo registrado deste servidor; as janelas do ranking continuam como estão',
      );

      return { detected: false, wipeId: recorded.id };
    }

    if (this.#alreadyTurnedFor(serverId, recorded.id)) {
      return { detected: false, wipeId: recorded.id };
    }

    this.#deps.logger?.info(
      { server: serverId, saveCreatedAt, wipeId: recorded.id },
      'mundo novo detectado fora de uma execução de wipe; a linha foi gravada em `wipes`',
    );

    return { detected: true, wipeId: recorded.id };
  }

  /**
   * As janelas já viraram neste mundo?
   *
   * ####  UMA VIRADA POR MUNDO  ####
   *
   * A execução de wipe e o detector do sweep olham para o MESMO
   * fato, e podem chegar em qualquer ordem — o coletor roda a cada
   * minuto, e o passo `#posWipe` roda quando o mundo sobe. Sem esta
   * pergunta, os dois virariam a janela, e a segunda virada
   * congelaria um pódio vazio por cima do que a primeira acabou de
   * gravar.
   *
   * A resposta está no próprio período aberto: depois da virada ele
   * aponta para a linha de `wipes` daquele mundo.
   */
  #alreadyTurnedFor(serverId: string, wipeId: number | null): boolean {
    if (wipeId === null) {
      return false;
    }

    return this.#deps.repository.openPeriodOf(serverId, 'wipe')?.wipeId === wipeId;
  }

  /**
   * Os segundos que cada jogador ganhou desde a rodada anterior.
   *
   * As três bordas do §8.4, e as três respostas:
   *
   *   - primeira rodada (sem marca): soma ZERO, só semeia;
   *   - delta negativo (base recriada, jogador removido): soma
   *     ZERO e a marca é regravada no valor menor;
   *   - período fechou entre duas rodadas: o delta cai todo no
   *     período novo. Aceitável e declarado — o erro máximo é uma
   *     rodada de 60 s.
   *
   * A função é PURA quanto à marca: ela não a move. Quem a move é
   * quem viu a escrita acontecer.
   */
  #playedRound(serverId: string): {
    readonly current: Map<string, number>;
    readonly deltas: Map<string, number>;
  } {
    const current = new Map(this.#deps.players.playedSecondsOf(serverId));
    const marks = this.#marks.get(serverId);
    const deltas = new Map<string, number>();

    if (marks === undefined) {
      return { current, deltas };
    }

    for (const [steamId, seconds] of current) {
      const previous = marks.get(steamId);

      if (previous === undefined) {
        // Jogador que apareceu entre duas rodadas: ele ainda não
        // tem passado para comparar. A marca nasce agora, e o
        // primeiro delta dele é o da rodada seguinte.
        continue;
      }

      const delta = seconds - previous;

      if (delta > 0) {
        deltas.set(steamId, delta);
      }
    }

    return { current, deltas };
  }

  /**
   * Confirma o lote. Falhar aqui NÃO é perder nada.
   *
   * O plugin segura o lote pendente até o `ack` chegar: uma queda
   * de RCON aqui faz a rodada seguinte receber o MESMO `batchId`,
   * que o `stat_batches` reconhece e recusa somar de novo — e o
   * `ack` sai de novo. É por isso que este caminho loga e segue em
   * vez de lançar.
   */
  async #ack(serverId: string, rcon: OpsRcon, batchId: string): Promise<void> {
    if (batchId === '') {
      return;
    }

    try {
      const raw = await rcon.send(buildStatsAckCommand(batchId));
      const parsed = statsAckResponseSchema.safeParse(firstJsonLine(raw));

      if (!parsed.success) {
        this.#deps.logger?.warn(
          { server: serverId, batchId },
          'o plugin respondeu ao ack fora do contrato; o lote volta inteiro na próxima rodada',
        );

        return;
      }

      if (!parsed.data.ok && parsed.data.error !== STATS_NO_BATCH) {
        this.#deps.logger?.warn(
          { server: serverId, batchId, error: parsed.data.error },
          'o plugin recusou o ack',
        );
      }
    } catch (error) {
      this.#deps.logger?.warn(
        { server: serverId, batchId, err: toError(error) },
        'o ack não chegou ao plugin; o lote continua pendente e volta na próxima rodada',
      );
    }
  }
}

// ------------------------------------------------------------
//  A costura do tempo online com o lote
// ------------------------------------------------------------

/**
 * Junta os segundos de jogo aos contadores que vieram do plugin.
 *
 * ####  POR QUE NO MESMO LOTE, E NÃO NUMA ESCRITA SEPARADA  ####
 *
 * Porque uma escrita separada precisaria de um `batchId` próprio, e
 * um por minuto por servidor encheria `stat_batches` de linhas que
 * não idempotizam nada — a marca d'água já é a idempotência do
 * tempo. Pendurar os segundos no `batchId` do plugin dá as duas
 * coisas de graça: uma transação só, e um lote replicado que não
 * soma o tempo duas vezes.
 */
export function mergePlayers(
  players: readonly StatsFlushPlayer[],
  timePlayed: ReadonlyMap<string, number>,
): readonly {
  readonly steamId: string;
  readonly name: string | null;
  readonly metrics: Readonly<Record<string, number>>;
}[] {
  const byPlayer = new Map<string, { name: string | null; metrics: Record<string, number> }>();

  for (const player of players) {
    byPlayer.set(player.steamId, {
      name: player.name ?? null,
      metrics: { ...player.metrics },
    });
  }

  for (const [steamId, seconds] of timePlayed) {
    const found = byPlayer.get(steamId);

    if (found === undefined) {
      byPlayer.set(steamId, { name: null, metrics: { [TIME_PLAYED_METRIC]: seconds } });
      continue;
    }

    // O plugin não conta tempo, então esta chave nunca colide de
    // verdade. A soma está aqui para o dia em que ele contar.
    found.metrics[TIME_PLAYED_METRIC] = (found.metrics[TIME_PLAYED_METRIC] ?? 0) + seconds;
  }

  return [...byPlayer.entries()].map(([steamId, data]) => ({
    steamId,
    name: data.name,
    metrics: data.metrics,
  }));
}
