// ============================================================
//  presence.ts  -  quem entrou, quem saiu, e há quanto tempo cada
//  um está aí.
//
//  ####  VARREDURA, E NÃO LINHA DE LOG  ####
//
//  A cada rodada o agente compara quem o SERVIDOR lista com quem a
//  TABELA diz estar online. Quem apareceu, entrou; quem sumiu,
//  saiu. É simples, sobrevive a reinício do agente, e — o que
//  decide a escolha — não depende de decorar o formato de uma
//  linha de log.
//
//  Essa lição já foi paga uma vez neste projeto: a primeira versão
//  do chat lia as linhas do RCON e ficava VAZIA num servidor com
//  plugin de chat, porque o plugin cancela a mensagem original. O
//  texto de uma linha de log tem dono, e o dono não somos nós.
//
//  Um evento de entrada/saída vindo do plugin, se um dia existir,
//  ACELERA isto — não o substitui.
//
//  ------------------------------------------------------------
//  ####  A HORA DA ENTRADA VEM DO SERVIDOR, NÃO DO RELÓGIO
//        DAQUI  ####
//
//  As duas fontes de jogadores trazem `connectedSeconds`, e é dele
//  que sai o começo da sessão (`agora - connectedSeconds`). Isso
//  faz três coisas de uma vez:
//
//    1. a primeira rodada depois de o agente subir grava a hora em
//       que o jogador REALMENTE entrou, e não a hora em que o
//       agente chegou;
//    2. um jogador que reconectou enquanto o agente estava fora é
//       reconhecido: a conexão dele começou depois do `joined_at`
//       gravado, então aquilo é OUTRA sessão;
//    3. a reconciliação do boot deixa de ser um caso especial —
//       ela é simplesmente a primeira varredura.
//
//  ####  AS TRÊS ARMADILHAS, E O QUE CADA UMA CUSTA  ####
//
//  1. O AGENTE REINICIA COM GENTE ONLINE. As sessões abertas
//     ficariam com `joined_at` preenchido para sempre e o tempo
//     jogado explodiria. A rodada fecha quem o servidor não lista,
//     com `left_at` no ÚLTIMO INSTANTE EM QUE ELE FOI VISTO — e
//     não em "agora", que contaria como tempo de jogo as horas em
//     que o agente esteve fora do ar.
//
//  2. O SERVIDOR CAI. Mesma coisa, pelo gancho que já existe:
//     `onRconConnected` avisa quando a conexão volta, e é ele que
//     dispara a rodada — o mesmo lugar em que a lista de banidos
//     reconcilia hoje.
//
//  3. "SEM POSIÇÃO" NÃO É "OFFLINE". Quem decide quem está online
//     é ESTAR NA LISTA do servidor, e nada mais. Um jogador
//     dormindo continua conectado no Rust, e tratá-lo como saída
//     faria a contagem da rede discordar da do jogo.
//
//  ####  E ELA NUNCA AGE SOBRE UM PALPITE  ####
//
//  Não conseguir ler a lista (RCON fora, plugin respondendo fora
//  do contrato) ADIA a rodada inteira. Supor lista vazia ali
//  marcaria o servidor cheio como vazio e fecharia a sessão de todo
//  mundo — a mesma regra da reconciliação de banimentos.
// ============================================================

import { STEAM_ID_PATTERN } from '../bans/rust-bans.js';
import type { PlayersRepository, PlayerSighting } from '../db/players-repository.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

/**
 * De quanto em quanto tempo perguntar quem está online.
 *
 * É um comando de RCON por servidor por rodada. Quinze segundos é
 * o suficiente para "entrar no jogo e ver o jogador aparecer na
 * lista de rede em segundos", e barato o bastante para rodar o dia
 * inteiro em cinco servidores.
 */
export const DEFAULT_PRESENCE_INTERVAL_MS = 15_000;

/**
 * Diferença tolerada entre a hora de entrada gravada e a que o
 * servidor informa agora.
 *
 * `connectedSeconds` é inteiro e o relógio das duas pontas não é o
 * mesmo, então a conta oscila alguns segundos a cada rodada. Sem a
 * folga, cada varredura acharia que a sessão é nova e o contador
 * de entradas subiria sozinho; com ela, só uma reconexão de
 * verdade passa.
 */
const SESSION_DRIFT_MS = 120_000;

/**
 * A partir de quando uma rodada é RECONCILIAÇÃO, e não
 * continuação.
 *
 * Se a rodada anterior daquele servidor foi há mais que isto, o
 * agente esteve sem olhar — e quem sumiu nesse intervalo não "saiu
 * agora", ele foi perdido de vista. A diferença aparece no motivo
 * da saída, que é o que a ficha mostra.
 */
const STALE_AFTER_MS = 90_000;

/** Um jogador como a varredura precisa vê-lo. */
export interface PresencePlayer {
  readonly steamId: string;
  readonly name: string;
  /** Segundos desde a conexão. `null` = a fonte não sabe. */
  readonly connectedSeconds: number | null;
  /** Só o `playerlist` nativo traz. Ver a migração 006. */
  readonly ip: string | null;
}

/**
 * O que a presença precisa do leitor de jogadores.
 *
 * Interface mínima, e de propósito: quem a satisfaz em produção é
 * o `PlayersReader` (game/players.ts), e um teste a satisfaz com
 * uma função. Falar com o RCON daqui seria um segundo caminho para
 * a mesma pergunta — e o segundo é o que diverge no primeiro
 * ajuste.
 */
export interface PresenceReader {
  list(
    serverId: string,
    rcon: OpsRcon,
    worldSize: number,
  ): Promise<{ readonly players: readonly PresencePlayer[] }>;
}

/** O que ela precisa saber dos servidores. E nada além disso. */
export interface PresenceServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
  configOf(id: string): { readonly worldSize: number } | null;
}

export interface PresenceTrackerDeps {
  readonly repository: PlayersRepository;
  readonly reader: PresenceReader;
  readonly servers: PresenceServers;
  readonly logger: Logger;
}

/** O que uma rodada fez naquele servidor. */
export interface PresenceSyncResult {
  readonly serverId: string;
  /** Quantos o servidor listou. */
  readonly online: number;
  /** SteamIDs cuja sessão foi aberta agora. */
  readonly joined: readonly string[];
  /** SteamIDs cuja sessão foi fechada agora. */
  readonly left: readonly string[];
  /**
   * Por que a rodada não aconteceu. `null` = ela aconteceu.
   *
   * Não é erro: servidor parado é o estado normal de metade da
   * lista. O que não pode é agir mesmo assim.
   */
  readonly skipped: string | null;
}

export class PresenceTracker {
  readonly #deps: PresenceTrackerDeps;

  /**
   * id do servidor -> quando a última rodada dele deu certo.
   *
   * Em memória, e não no banco: ele responde "eu estava olhando há
   * pouco?", que é uma pergunta sobre ESTA execução do agente.
   * Depois de um reinício a resposta certa é "não", e um mapa
   * vazio já diz isso.
   */
  readonly #lastSyncAt = new Map<string, number>();

  constructor(deps: PresenceTrackerDeps) {
    this.#deps = deps;
  }

  /**
   * Uma rodada naquele servidor.
   *
   * É a mesma função no relógio, no boot e na reconexão do RCON —
   * ver o cabeçalho. O que muda entre os três é só o motivo que
   * fica gravado na saída de quem sumiu.
   */
  async sync(serverId: string, now: number = Date.now()): Promise<PresenceSyncResult> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null) {
      return skipped(
        serverId,
        `O agente não está cuidando do servidor "${serverId}" — quem está online só dá para ` +
          'perguntar pelo RCON.',
      );
    }

    if (!context.rcon.isConnected) {
      return skipped(
        serverId,
        `O RCON de "${serverId}" está fora do ar. A presença será conferida quando ele voltar.`,
      );
    }

    let listed: readonly PresencePlayer[];

    try {
      const worldSize = this.#deps.servers.configOf(serverId)?.worldSize ?? 0;
      const read = await this.#deps.reader.list(serverId, context.rcon, worldSize);

      // ####  QUEM NÃO TEM SteamID64 NÃO É JOGADOR  ####
      //
      // O `playerlist` nativo lista também os bots do servidor, e o
      // userID deles não é conta de Steam. Guardá-los encheria a
      // tela de rede de gente que ninguém pode banir, procurar nem
      // abrir a ficha — e a rota da ficha, que exige 17 dígitos,
      // recusaria justamente as linhas que a lista mostrasse.
      listed = read.players.filter((player) => STEAM_ID_PATTERN.test(player.steamId));
    } catch (error) {
      // Ver o cabeçalho: sem lista, NADA acontece. Uma resposta que
      // não deu para entender e um servidor vazio são coisas
      // diferentes, e a segunda não pode ser suposta a partir da
      // primeira.
      return skipped(
        serverId,
        `Não consegui ler quem está online em "${serverId}": ${toError(error).message} Nada foi ` +
          'alterado — supor lista vazia aqui fecharia a sessão de todo mundo.',
      );
    }

    const previous = this.#lastSyncAt.get(serverId);
    const reason = leaveReasonFor(previous, now);
    const present = new Set(listed.map((player) => player.steamId));

    // As sessões abertas são lidas ANTES de qualquer escrita: é o
    // `last_seen` de agora há pouco que fecha a sessão de quem
    // sumiu, e ele muda no passo da avistagem.
    const open = new Map(
      this.#deps.repository.openSessions(serverId).map((session) => [session.steamId, session]),
    );

    const joined: string[] = [];
    const left: string[] = [];

    // 1. Quem a tabela diz estar aqui e o servidor não lista: saiu.
    //    A sessão fecha no ÚLTIMO INSTANTE EM QUE ELE FOI VISTO —
    //    ver o cabeçalho.
    for (const [steamId, session] of open) {
      if (present.has(steamId)) {
        continue;
      }

      this.#close(serverId, steamId, session.lastSeen, reason);
      left.push(steamId);
    }

    // 2. Quem está na lista sem sessão aberta: entrou. E quem está
    //    com sessão aberta mas conectou DEPOIS dela reconectou sem
    //    o agente ver — aquilo é outra sessão.
    for (const player of listed) {
      const session = open.get(player.steamId);
      const startedAt = startOfSession(player, now);

      if (session === undefined) {
        this.#open(serverId, player, startedAt);
        joined.push(player.steamId);
        continue;
      }

      if (
        player.connectedSeconds === null ||
        session.joinedAt === null ||
        startedAt - session.joinedAt <= SESSION_DRIFT_MS
      ) {
        continue;
      }

      this.#close(serverId, player.steamId, session.lastSeen, reason);
      this.#open(serverId, player, startedAt);
      left.push(player.steamId);
      joined.push(player.steamId);
    }

    // 3. A avistagem, em lote, POR ÚLTIMO: ela carimba `last_seen`
    //    em AGORA, e é o que dá o fim da sessão na rodada seguinte.
    //    Fazê-la antes das aberturas custaria a hora real da
    //    entrada — a linha nasceria com o horário da varredura, e
    //    não com o do jogador tendo entrado meia hora antes de o
    //    agente subir.
    this.#deps.repository.recordSightings(serverId, listed.map(toSighting), now);

    this.#lastSyncAt.set(serverId, now);

    if (joined.length + left.length > 0) {
      this.#deps.logger.debug(
        { server: serverId, joined, left, online: listed.length },
        'presença conferida',
      );
    }

    return { serverId, online: listed.length, joined, left, skipped: null };
  }

  /**
   * Uma rodada em todos os servidores.
   *
   * Um servidor que falha não segura os outros: a rodada dele fica
   * para a próxima, e o motivo já vai no `skipped` do resultado.
   */
  async syncAll(now: number = Date.now()): Promise<readonly PresenceSyncResult[]> {
    const results: PresenceSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      try {
        results.push(await this.sync(serverId, now));
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, err: toError(error) },
          'não consegui conferir a presença deste servidor',
        );
      }
    }

    return results;
  }

  /**
   * Abre a sessão na hora em que ela COMEÇOU.
   *
   * A avistagem vem antes da abertura, e com a mesma hora, por dois
   * motivos: `player_servers.steam_id` referencia `players`, então
   * a pessoa precisa existir antes da linha do servidor; e é ela
   * que grava o "jogador desde" — que, para quem acabou de entrar,
   * é o começo da conexão, e não o instante em que a varredura
   * passou por aqui.
   */
  #open(serverId: string, player: PresencePlayer, at: number): void {
    this.#deps.repository.recordSightings(serverId, [toSighting(player)], at);
    this.#deps.repository.openSession(serverId, player.steamId, at);
    this.#deps.repository.recordEvent({ steamId: player.steamId, serverId, kind: 'join' }, at);
  }

  #close(serverId: string, steamId: string, at: number, reason: string | null): void {
    // O evento só entra se havia mesmo sessão para fechar: sem
    // isso, uma rodada repetida encheria a linha do tempo de saídas
    // que não aconteceram.
    if (this.#deps.repository.closeSession(serverId, steamId, at, reason)) {
      this.#deps.repository.recordEvent({ steamId, serverId, kind: 'leave', detail: reason }, at);
    }
  }
}

/**
 * O relógio da presença.
 *
 * Mesmo desenho do vigia da Steam e do relógio dos banimentos:
 * intervalo configurável, `unref()` no timer para não segurar o
 * processo vivo, e uma rodada por vez — a varredura fala com N
 * servidores pelo RCON e pode passar do intervalo; duas em
 * paralelo escreveriam a mesma sessão duas vezes.
 *
 * A primeira rodada sai no BOOT, e não depois do intervalo: é ela
 * que fecha as sessões que ficaram abertas quando o agente caiu.
 */
export class PresenceWatcher {
  readonly #tracker: PresenceTracker;
  readonly #logger: Logger;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** Uma rodada por vez. Ver o cabeçalho. */
  #running = false;

  constructor(options: {
    readonly tracker: PresenceTracker;
    readonly logger: Logger;
    readonly intervalMs?: number;
  }) {
    this.#tracker = options.tracker;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_PRESENCE_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    this.#timer.unref();

    this.#logger.info(
      { intervalSeconds: Math.round(this.#intervalMs / 1000) },
      'relógio da presença ligado',
    );

    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma passada.
   *
   * Nunca lança: um erro aqui é de rotina, e derrubar o relógio por
   * causa dele deixaria a presença parada para sempre — em
   * silêncio, que é o pior jeito de um relógio falhar.
   */
  async sweep(): Promise<void> {
    if (this.#running) {
      this.#logger.debug('presença: a rodada anterior ainda não terminou');
      return;
    }

    this.#running = true;

    try {
      await this.#tracker.syncAll();
    } catch (error) {
      this.#logger.warn(
        { err: toError(error) },
        'a varredura de presença falhou; a próxima rodada tenta de novo',
      );
    } finally {
      this.#running = false;
    }
  }
}

/**
 * Quando a sessão atual daquele jogador começou.
 *
 * Sem `connectedSeconds` sobra o relógio daqui, e ele só está
 * certo quando o jogador acabou de entrar — que é o caso comum da
 * varredura em regime. Ver o cabeçalho.
 */
function startOfSession(player: PresencePlayer, now: number): number {
  if (player.connectedSeconds === null) {
    return now;
  }

  return now - Math.max(0, Math.round(player.connectedSeconds)) * 1000;
}

/**
 * Por que a sessão de quem sumiu está sendo fechada.
 *
 * Uma saída vista entre duas rodadas seguidas é uma saída de
 * verdade, e o jogo não diz o motivo dela — `null`, que na tela
 * vira travessão. Já quem some depois de um intervalo em que o
 * agente não estava olhando não "saiu agora": ele foi perdido de
 * vista, e dizer isso é o que impede a ficha de afirmar uma hora
 * de saída que ninguém observou.
 */
function leaveReasonFor(previousSyncAt: number | undefined, now: number): string | null {
  if (previousSyncAt === undefined) {
    return 'agente reiniciado';
  }

  return now - previousSyncAt > STALE_AFTER_MS ? 'sem contato com o servidor' : null;
}

function toSighting(player: PresencePlayer): PlayerSighting {
  return { steamId: player.steamId, name: player.name, ip: player.ip };
}

function skipped(serverId: string, reason: string): PresenceSyncResult {
  return { serverId, online: 0, joined: [], left: [], skipped: reason };
}
