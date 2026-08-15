// ============================================================
//  players-repository.ts  -  quem já jogou na rede, e o que ele
//  fez em cada servidor.
//
//  Três tabelas, e cada uma responde a uma pergunta diferente
//  (ver o cabeçalho da migração 006):
//
//      players         QUEM ele é      — um por SteamID
//      player_servers  O QUE ele fez   — um por (servidor, jogador)
//      player_events   O QUE ACONTECEU — a linha do tempo
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Perguntar ao servidor quem está online é trabalho do
//  `PlayersReader` (game/players.ts); decidir quem entrou e quem
//  saiu é de players/presence.ts. Aqui só entra e sai linha — e
//  essa separação é o que permite testar as regras que importam
//  ("o mesmo SteamID em dois servidores é UMA pessoa", "fechar a
//  sessão duas vezes não dobra o tempo") com um banco em memória,
//  sem servidor de Rust nenhum.
//
//  ####  O steamId É STRING EM TODA PARTE  ####
//
//  No banco, aqui, no zod e no JSON. Um SteamID64 tem 17 dígitos
//  e passa de 2^53: convertido para número, ele volta arredondado
//  — e a ficha seria de OUTRA PESSOA, sem erro nenhum no caminho.
//
//  ####  first_seen NÃO APARECE EM NENHUM `DO UPDATE`  ####
//
//  É o que o preserva. Ele é o "jogador desde", nas duas pontas
//  (rede e servidor), e reescrevê-lo apagaria a única informação
//  daqui que não dá para reconstruir de nenhuma outra fonte.
// ============================================================

import type { AgentDatabase } from './database.js';

/** A PESSOA, sem servidor nenhum. Datas em epoch ms. */
export interface PlayerRecord {
  readonly steamId: string;
  readonly name: string;
  /** Na REDE, e nunca muda depois da inserção. */
  readonly firstSeen: number;
  /** Na REDE: o mais recente de qualquer servidor. */
  readonly lastSeen: number;
  /** `null` = nenhuma fonte trouxe IP. Ver a migração 006. */
  readonly lastIp: string | null;
}

/** O que a pessoa fez em UM servidor. */
export interface PlayerServerRecord {
  readonly serverId: string;
  readonly steamId: string;
  /** Primeira vez NESTE servidor. Ver o cabeçalho. */
  readonly firstSeen: number;
  readonly lastSeen: number;
  /**
   * A sessão corrente (ou a última) NESTE servidor.
   *
   * `joinedAt` preenchido com `leftAt` nulo = está online AQUI — e
   * é assim que `online` é decidido em toda parte. Uma coluna
   * booleana seria a segunda fonte para o mesmo fato, e ela
   * ficaria `1` para sempre no dia em que o agente caísse.
   */
  readonly joinedAt: number | null;
  readonly leftAt: number | null;
  readonly leaveReason: string | null;
  readonly sessions: number;
  /** Somado no FECHAMENTO de cada sessão. Em segundos. */
  readonly playedSeconds: number;
}

/**
 * O tipo de um evento da linha do tempo.
 *
 * Os quatro primeiros são da migração 006; `vip` e `kit` entraram
 * com a 014 e `compra` com a 017 — as duas ampliaram o `CHECK` da
 * tabela. Acrescentar um valor aqui SEM a migração faria o `INSERT`
 * estourar no banco — e só na máquina de quem já está de pé.
 */
export type PlayerEventKind = 'join' | 'leave' | 'kick' | 'teleport' | 'vip' | 'kit' | 'compra';

export interface PlayerEventRecord {
  readonly id: number;
  readonly steamId: string;
  readonly serverId: string;
  readonly kind: PlayerEventKind;
  readonly at: number;
  /** Quem pediu. `null` no que o jogo fez sozinho. */
  readonly actor: string | null;
  readonly detail: string | null;
}

export interface PlayerEventInput {
  readonly steamId: string;
  readonly serverId: string;
  readonly kind: PlayerEventKind;
  readonly actor?: string | null;
  readonly detail?: string | null;
}

/**
 * Um sinal de vida.
 *
 * `name` vazio e `ip` nulo querem dizer "não sei", nunca "apague":
 * a fonte do plugin não traz IP, e um evento pode chegar antes de
 * o nome ser conhecido.
 */
export interface PlayerSighting {
  readonly steamId: string;
  readonly name: string;
  readonly ip?: string | null;
}

export interface ListPlayersOptions {
  /** Trecho de SteamID ou de nome. */
  readonly query?: string | undefined;
  /** `true` = só quem tem sessão aberta em algum servidor. */
  readonly online?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface ListPlayersResult {
  readonly players: readonly PlayerRecord[];
  /** Quantos casaram com o filtro ANTES da paginação. */
  readonly total: number;
}

interface PlayerRow {
  readonly steam_id: string;
  readonly name: string;
  readonly first_seen: number;
  readonly last_seen: number;
  readonly last_ip: string | null;
}

interface PlayerServerRow {
  readonly server_id: string;
  readonly steam_id: string;
  readonly first_seen: number;
  readonly last_seen: number;
  readonly joined_at: number | null;
  readonly left_at: number | null;
  readonly leave_reason: string | null;
  readonly sessions: number;
  readonly played_seconds: number;
}

interface PlayerEventRow {
  readonly id: number;
  readonly steam_id: string;
  readonly server_id: string;
  readonly kind: string;
  readonly at: number;
  readonly actor: string | null;
  readonly detail: string | null;
}

/**
 * A avistagem da PESSOA, em uma instrução.
 *
 * Três decisões estão codificadas aqui, e cada uma responde a um
 * jeito de a tabela ficar errada:
 *
 *   - `first_seen` não está no DO UPDATE — é o que o preserva;
 *   - `name` passa por `NULLIF`: uma avistagem sem nome não apaga
 *     o nome que a lista de online já tinha gravado;
 *   - `last_ip` idem. A fonte do plugin não traz IP, e sem o
 *     COALESCE toda leitura por lá zeraria a coluna.
 */
const UPSERT_PLAYER = `
INSERT INTO players (steam_id, name, first_seen, last_seen, last_ip, created_at, updated_at)
     VALUES (@steam_id, @name, @at, @at, @ip, @at, @at)
ON CONFLICT (steam_id) DO UPDATE SET
     name       = COALESCE(NULLIF(@name, ''), players.name),
     last_seen  = @at,
     last_ip    = COALESCE(@ip, players.last_ip),
     updated_at = @at
`;

/**
 * A mesma avistagem, do lado do servidor.
 *
 * SÓ as duas datas. A lista de online diz que ele ESTÁ ali, não a
 * hora em que entrou nem quantas vezes já entrou — mexer em
 * `joined_at` daqui inventaria uma entrada a cada varredura.
 */
const UPSERT_PLAYER_SERVER = `
INSERT INTO player_servers (server_id, steam_id, first_seen, last_seen)
     VALUES (@server_id, @steam_id, @at, @at)
ON CONFLICT (server_id, steam_id) DO UPDATE SET
     last_seen = @at
`;

/**
 * Teto de parâmetros por instrução, com folga (o SQLite antigo
 * para em 999).
 *
 * A página da listagem é bem menor que isso, mas a mesma consulta
 * serve à lista de online de um servidor cheio.
 */
const MAX_SQL_PARAMS = 400;

export class PlayersRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  get(steamId: string): PlayerRecord | null {
    const row = this.#db.prepare('SELECT * FROM players WHERE steam_id = @steam_id').get({
      steam_id: steamId,
    }) as PlayerRow | undefined;

    return row === undefined ? null : toPlayer(row);
  }

  /**
   * Uma página da rede, do visto mais recentemente para o mais
   * antigo.
   *
   * ####  A PAGINAÇÃO EXISTE DESDE A PRIMEIRA VERSÃO  ####
   *
   * Uma rede com meses de vida tem dezenas de milhares de
   * jogadores, e uma consulta que devolve tudo é a que um dia
   * derruba o agente. O `total` vai junto porque sem ele a tela
   * não sabe se há página seguinte.
   *
   * O desempate por `steam_id` não é zelo: uma varredura carimba o
   * MESMO `last_seen` em todos os jogadores do lote, e sem ele a
   * ordem entre eles mudaria de uma requisição para a outra — a
   * paginação repetiria ou pularia linhas.
   *
   * O SQL é estático e o filtro é um parâmetro que pode vir nulo:
   * montar o WHERE por concatenação seria mais um ponto em que
   * texto de query string encosta no SQL.
   */
  list(options: ListPlayersOptions): ListPlayersResult {
    const filters = {
      q:
        options.query === undefined || options.query.trim() === ''
          ? null
          : `%${escapeLike(options.query.trim())}%`,
      online: options.online === true ? 1 : 0,
    };

    const where = `
      WHERE (@q IS NULL OR p.steam_id LIKE @q ESCAPE '\\' OR p.name LIKE @q ESCAPE '\\')
        AND (@online = 0 OR EXISTS (
              SELECT 1 FROM player_servers s
               WHERE s.steam_id = p.steam_id
                 AND s.joined_at IS NOT NULL
                 AND s.left_at IS NULL))
    `;

    const total = (
      this.#db.prepare(`SELECT count(*) AS total FROM players p ${where}`).get(filters) as {
        readonly total: number;
      }
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT p.* FROM players p
         ${where}
          ORDER BY p.last_seen DESC, p.steam_id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...filters, limit: options.limit, offset: options.offset }) as PlayerRow[];

    return { players: rows.map(toPlayer), total };
  }

  /** Onde ele jogou, do servidor mais recente para o mais antigo. */
  serversOf(steamId: string): readonly PlayerServerRecord[] {
    return this.presenceOf([steamId]).get(steamId) ?? [];
  }

  /**
   * As linhas de servidor de VÁRIOS jogadores, numa consulta só.
   *
   * É o que permite a listagem dizer, em cada linha, onde o jogador
   * está agora — sem uma consulta por linha da página, que é o N+1
   * clássico desta tela.
   *
   * O `IN (?, ?, …)` é montado a partir do TAMANHO da lista; os
   * valores continuam sendo parâmetros ligados, e nenhum SteamID
   * encosta no texto do SQL.
   */
  presenceOf(steamIds: readonly string[]): Map<string, PlayerServerRecord[]> {
    const byPlayer = new Map<string, PlayerServerRecord[]>();

    for (const chunk of chunked(steamIds)) {
      const rows = this.#db
        .prepare(
          `SELECT * FROM player_servers
            WHERE steam_id IN (${chunk.map(() => '?').join(', ')})
            ORDER BY last_seen DESC, server_id ASC`,
        )
        .all(...chunk) as PlayerServerRow[];

      for (const row of rows) {
        const list = byPlayer.get(row.steam_id);

        if (list === undefined) {
          byPlayer.set(row.steam_id, [toPlayerServer(row)]);
        } else {
          list.push(toPlayerServer(row));
        }
      }
    }

    return byPlayer;
  }

  /**
   * Quem está com sessão ABERTA naquele servidor.
   *
   * É o outro lado da varredura: a lista do jogo diz quem está lá,
   * isto diz quem o agente ACHA que está. A diferença entre as duas
   * é quem entrou e quem saiu — ver players/presence.ts.
   */
  openSessions(serverId: string): readonly PlayerServerRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM player_servers
          WHERE server_id = @server_id AND joined_at IS NOT NULL AND left_at IS NULL`,
      )
      .all({ server_id: serverId }) as PlayerServerRow[];

    return rows.map(toPlayerServer);
  }

  /** Os N últimos eventos daquele jogador, do mais novo ao mais velho. */
  events(steamId: string, limit: number): readonly PlayerEventRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM player_events
          WHERE steam_id = @steam_id
          ORDER BY at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ steam_id: steamId, limit }) as PlayerEventRow[];

    return rows.map(toEvent);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * O lote de uma varredura: estes jogadores estão neste servidor
   * AGORA.
   *
   * ####  O QUE TORNA ISTO BARATO  ####
   *
   * Uma varredura de um servidor cheio são 200 jogadores, ou seja
   * 400 upserts, a cada intervalo. Três coisas seguram o custo: UMA
   * transação para o lote (sem ela o SQLite trataria cada INSERT
   * como uma transação própria — 400 commits em vez de 1), DUAS
   * prepared statements reusadas nas 200 linhas, e nenhum SELECT
   * antes de escrever: cada upsert entra pela chave primária.
   *
   * Lote vazio sai antes da transação: servidor sem ninguém é o
   * estado normal de madrugada, e abrir e fechar transação para não
   * escrever nada seria trabalho por nada a cada rodada.
   */
  recordSightings(
    serverId: string,
    sightings: readonly PlayerSighting[],
    at: number = Date.now(),
  ): void {
    if (sightings.length === 0) {
      return;
    }

    const run = this.#db.transaction((): void => {
      const player = this.#db.prepare(UPSERT_PLAYER);
      const playerServer = this.#db.prepare(UPSERT_PLAYER_SERVER);

      for (const sighting of sightings) {
        player.run({
          steam_id: sighting.steamId,
          name: sighting.name,
          ip: sighting.ip ?? null,
          at,
        });

        playerServer.run({ server_id: serverId, steam_id: sighting.steamId, at });
      }
    });

    run();
  }

  /**
   * Abre a sessão daquele jogador NAQUELE servidor.
   *
   * `sessions` incrementa aqui e em nenhum outro lugar, então o
   * número é "quantas vezes ele entrou neste servidor desde que o
   * agente passou a olhar" — e não desde o começo do mundo.
   *
   * `left_at` e `leave_reason` são ZERADOS: são eles que respondem
   * "está online agora?", e deixar o valor antigo faria um jogador
   * conectado parecer que saiu na sessão anterior. E só na linha
   * DESTE servidor — quem entra no `pve` continua com a sessão do
   * `pvp1` intacta.
   *
   * O upsert cobre o jogador que o agente nunca viu: a primeira
   * entrada dele cria a linha em vez de não fazer nada.
   */
  openSession(serverId: string, steamId: string, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO player_servers
              (server_id, steam_id, first_seen, last_seen, joined_at, sessions)
              VALUES (@server_id, @steam_id, @at, @at, @at, 1)
         ON CONFLICT (server_id, steam_id) DO UPDATE SET
              -- MAX, e não uma atribuição direta: a hora de ENTRADA
              -- é anterior à da varredura que a descobriu, e
              -- deixá-la sobrescrever last_seen faria a sessão
              -- fechar com duração zero. last_seen só anda para a
              -- frente.
              last_seen    = MAX(player_servers.last_seen, @at),
              joined_at    = @at,
              left_at      = NULL,
              leave_reason = NULL,
              sessions     = player_servers.sessions + 1`,
      )
      .run({ server_id: serverId, steam_id: steamId, at });
  }

  /**
   * Fecha a sessão e SOMA o tempo dela.
   *
   * ####  FECHAR DUAS VEZES NÃO DOBRA O NÚMERO  ####
   *
   * O `WHERE` exige sessão aberta (`joined_at` preenchido,
   * `left_at` nulo), e o próprio UPDATE a fecha. A segunda chamada
   * não casa com linha nenhuma — que é a propriedade que permite
   * rodar a reconciliação do boot quantas vezes for preciso.
   *
   * ####  O FIM DA SESSÃO É `endedAt`, E QUEM O ESCOLHE É QUEM
   *       CHAMA  ####
   *
   * E o valor certo quase sempre é o `last_seen` daquela linha: o
   * último instante em que o agente VIU o jogador ali. Somar até
   * "agora" na reconciliação do boot contaria como tempo de jogo as
   * horas em que o agente esteve fora do ar — ver
   * players/presence.ts.
   *
   * @returns `true` se havia sessão aberta para fechar.
   */
  closeSession(serverId: string, steamId: string, endedAt: number, reason: string | null): boolean {
    const result = this.#db
      .prepare(
        `UPDATE player_servers
            SET left_at        = @ended_at,
                leave_reason   = @reason,
                last_seen      = MAX(last_seen, @ended_at),
                -- MAX(0, …) protege contra relógio para trás: uma
                -- sessão de duração negativa subtrairia tempo já
                -- somado, e o número nunca mais fecharia.
                played_seconds = played_seconds
                                 + CAST(MAX(0, @ended_at - joined_at) / 1000 AS INTEGER)
          WHERE server_id = @server_id
            AND steam_id  = @steam_id
            AND joined_at IS NOT NULL
            AND left_at   IS NULL`,
      )
      .run({ server_id: serverId, steam_id: steamId, ended_at: endedAt, reason });

    return result.changes > 0;
  }

  /**
   * Grava um evento da linha do tempo.
   *
   * Ele NÃO cria o jogador: quem chama já o avistou (a varredura)
   * ou está agindo sobre alguém conectado (o kick, o teleporte). Um
   * evento de um SteamID que não está em `players` continua legível
   * — a tabela não tem chave estrangeira para lá de propósito, para
   * que uma limpeza futura de jogadores nunca apague história.
   */
  recordEvent(event: PlayerEventInput, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO player_events (steam_id, server_id, kind, at, actor, detail)
              VALUES (@steam_id, @server_id, @kind, @at, @actor, @detail)`,
      )
      .run({
        steam_id: event.steamId,
        server_id: event.serverId,
        kind: event.kind,
        at,
        actor: event.actor ?? null,
        detail: event.detail ?? null,
      });
  }
}

/**
 * Neutraliza os curingas do LIKE.
 *
 * Sem isto, buscar por "%" no painel casaria com a base inteira e
 * um "_" casaria com qualquer caractere — a busca mentiria sobre o
 * que encontrou.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function chunked(steamIds: readonly string[]): string[][] {
  const chunks: string[][] = [];

  for (let index = 0; index < steamIds.length; index += MAX_SQL_PARAMS) {
    chunks.push([...steamIds.slice(index, index + MAX_SQL_PARAMS)]);
  }

  return chunks;
}

function toPlayer(row: PlayerRow): PlayerRecord {
  return {
    steamId: row.steam_id,
    name: row.name,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastIp: row.last_ip,
  };
}

function toPlayerServer(row: PlayerServerRow): PlayerServerRecord {
  return {
    serverId: row.server_id,
    steamId: row.steam_id,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    leaveReason: row.leave_reason,
    sessions: row.sessions,
    playedSeconds: row.played_seconds,
  };
}

/**
 * `kind` chega como `string` do SQLite. Quem garante os valores é o
 * `CHECK` da tabela — o estreitamento aqui só reconhece isso para o
 * TypeScript, e não substitui a trava.
 */
function toEvent(row: PlayerEventRow): PlayerEventRecord {
  return {
    id: row.id,
    steamId: row.steam_id,
    serverId: row.server_id,
    kind: isEventKind(row.kind) ? row.kind : 'join',
    at: row.at,
    actor: row.actor,
    detail: row.detail,
  };
}

/** Os mesmos valores do `CHECK` da tabela. Ver `PlayerEventKind`. */
const EVENT_KINDS: readonly string[] = ['join', 'leave', 'kick', 'teleport', 'vip', 'kit'];

function isEventKind(value: string): value is PlayerEventKind {
  return EVENT_KINDS.includes(value);
}

/** Este jogador está online AGORA, em algum servidor? */
export function isOnline(servers: readonly PlayerServerRecord[]): boolean {
  return servers.some((server) => server.joinedAt !== null && server.leftAt === null);
}
