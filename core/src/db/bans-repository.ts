// ============================================================
//  bans-repository.ts  -  quem está banido, desde quando, por
//  quem e até onde.
//
//  Duas tabelas, e a segunda só existe para uma das duas formas
//  de escopo:
//
//      bans          a lista, uma linha por banimento
//      ban_servers   os servidores de um ban `scope = 'servers'`
//
//  Um ban `network` NÃO tem linha em `ban_servers`. Ver o
//  cabeçalho da migração 005: enumerar os servidores de hoje faria
//  o ban deixar de valer no `pvp3` de amanhã, em silêncio.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Mandar `banid`, `unban` e `server.writecfg` é trabalho de
//  bans/service.ts. Aqui só entra e sai linha — e essa separação é
//  o que permite testar as regras que importam ("dois ativos para
//  o mesmo SteamID não existem", "um ban de rede vale num servidor
//  cadastrado depois dele") com um banco em memória, sem servidor
//  de Rust nenhum.
//
//  ####  O steamId É STRING EM TODA PARTE  ####
//
//  No banco, aqui, no zod e no JSON. Um SteamID64 tem 17 dígitos e
//  passa de 2^53: convertido para número, ele volta arredondado —
//  e o ban vai para a CONTA ERRADA, sem erro nenhum no caminho.
// ============================================================

import type { AgentDatabase } from './database.js';

/**
 * Onde o banimento vale.
 *
 *   `network`  em TODO servidor deste agente, inclusive nos que
 *              ainda vão ser cadastrados
 *   `servers`  só nos listados, e em nenhum outro
 */
export type BanScope = 'network' | 'servers';

/**
 * De onde a linha veio.
 *
 *   `panel`    alguém baniu pelo agente
 *   `adopted`  já estava no `bans.cfg` de um servidor quando o
 *              agente chegou. Ver `BanList.reconcile`.
 */
export type BanOrigin = 'panel' | 'adopted';

export interface BanRecord {
  readonly id: number;
  /** SteamID64, string. Ver o cabeçalho. */
  readonly steamId: string;
  /** O nome de quando foi banido. `null` = ninguém sabia. */
  readonly name: string | null;
  readonly reason: string;
  readonly scope: BanScope;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly createdBy: string | null;
  /** Epoch ms. `null` = permanente. */
  readonly expiresAt: number | null;
  /** Epoch ms. `null` = ativo. */
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly origin: BanOrigin;
  /**
   * Os servidores em que ele vale.
   *
   * SEMPRE vazio com `scope = 'network'` — e ali isso não quer
   * dizer "em nenhum", quer dizer "em todos". Quem lê os dois
   * campos juntos é `appliesTo`, abaixo; ler só este é o engano
   * que faria um ban de rede parecer inofensivo.
   */
  readonly servers: readonly string[];
}

export interface BanInput {
  readonly steamId: string;
  readonly name: string | null;
  readonly reason: string;
  readonly scope: BanScope;
  /** Ignorado com `scope = 'network'`. */
  readonly servers: readonly string[];
  /** Epoch ms. `null` = permanente. */
  readonly expiresAt: number | null;
  readonly createdBy: string | null;
  readonly origin: BanOrigin;
}

export interface ListBansOptions {
  /** `true` = só os que ainda não foram revogados. */
  readonly active?: boolean;
  /** Busca por SteamID ou por parte do nome. */
  readonly query?: string;
}

interface BanRow {
  readonly id: number;
  readonly steam_id: string;
  readonly name: string | null;
  readonly reason: string;
  readonly scope: string;
  readonly created_at: number;
  readonly created_by: string | null;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly revoked_by: string | null;
  readonly origin: string;
}

/**
 * Este ban vale naquele servidor?
 *
 * A regra inteira numa função, e exportada, porque a pergunta é
 * feita em três lugares — a lista do servidor, a reconciliação e a
 * tela. Três cópias divergiriam justamente no caso do `network`,
 * que é o que não pode.
 */
export function appliesTo(ban: BanRecord, serverId: string): boolean {
  return ban.scope === 'network' || ban.servers.includes(serverId);
}

/** Vale AGORA: não foi revogado e não venceu. */
export function isActive(ban: BanRecord, now: number = Date.now()): boolean {
  return ban.revokedAt === null && (ban.expiresAt === null || ban.expiresAt > now);
}

export class BansRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * A lista global.
   *
   * `active` aqui é "não revogado", e NÃO "não vencido": um ban que
   * passou da data continua valendo no jogo até o relógio passar
   * por ele (ver bans/expiry-watcher.ts), e escondê-lo da listagem
   * faria a tela dizer que o jogador está solto enquanto o
   * `bans.cfg` ainda o segura. O `expiresAt` vai na resposta para
   * a tela poder dizer "vencido, aguardando o unban".
   */
  list(options: ListBansOptions = {}): readonly BanRecord[] {
    const where: string[] = [];
    const params: Record<string, string> = {};

    if (options.active === true) {
      where.push('revoked_at IS NULL');
    }

    const query = options.query?.trim() ?? '';

    if (query !== '') {
      // `%` dos dois lados: a busca por nome é por pedaço, e a por
      // SteamID dá no mesmo que por prefixo.
      where.push('(steam_id LIKE @busca OR name LIKE @busca)');
      params.busca = `%${query}%`;
    }

    const rows = this.#db
      .prepare(
        `SELECT * FROM bans
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(params) as BanRow[];

    return this.#withServers(rows);
  }

  get(id: number): BanRecord | null {
    const row = this.#db.prepare('SELECT * FROM bans WHERE id = @id').get({ id }) as
      | BanRow
      | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /**
   * O banimento não revogado daquele SteamID, se houver.
   *
   * Devolve UM registro, e não uma lista, porque o
   * `idx_bans_active` garante que só existe um: dois ativos não
   * teriam resposta para "qual motivo vale?" nem para "revogar
   * fecha qual?".
   */
  activeOf(steamId: string): BanRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM bans WHERE steam_id = @steam_id AND revoked_at IS NULL')
      .get({ steam_id: steamId }) as BanRow | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /**
   * A linha MAIS RECENTE daquele SteamID, revogada ou não.
   *
   * ####  ELA RESPONDE UMA PERGUNTA QUE `activeOf` NÃO RESPONDE  ####
   *
   * "O agente já conheceu este banimento?". A reconciliação
   * precisa separar três coisas ao encontrar um SteamID no
   * `bans.cfg`:
   *
   *     ativo aqui        nada a fazer
   *     conhecido, sem valer   `unban` — a tabela mandou soltar
   *     nunca visto       adotar
   *
   * Com `activeOf` sozinho, o segundo caso seria indistinguível do
   * terceiro: revogar um ban com o servidor fora do ar faria a
   * reconexão ADOTAR de volta o mesmo banimento que acabou de ser
   * revogado — e a tela mostraria o jogador solto e banido ao
   * mesmo tempo.
   */
  latestOf(steamId: string): BanRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM bans
          WHERE steam_id = @steam_id
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get({ steam_id: steamId }) as BanRow | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /**
   * TODAS as linhas daquele SteamID, da mais nova para a mais
   * antiga.
   *
   * É o que a linha do tempo da ficha do jogador consome: ali a
   * pergunta não é "ele está banido?", é "o que já aconteceu com
   * ele?" — e um banimento revogado em março faz parte da resposta
   * tanto quanto o ativo de hoje.
   */
  historyOf(steamId: string): readonly BanRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM bans
          WHERE steam_id = @steam_id
          ORDER BY created_at DESC, id DESC`,
      )
      .all({ steam_id: steamId }) as BanRow[];

    return this.#withServers(rows);
  }

  /**
   * O que vale NAQUELE servidor, agora.
   *
   * ####  O `network` ENTRA SEM ESTAR LISTADO  ####
   *
   * Ele não tem linha em `ban_servers` — e é justamente isso que o
   * faz valer num servidor cadastrado DEPOIS dele. Um `JOIN` puro
   * devolveria só os específicos, e o sintoma seria o banido de
   * rede jogando no servidor novo.
   */
  activeFor(serverId: string, now: number = Date.now()): readonly BanRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT b.* FROM bans b
          WHERE b.revoked_at IS NULL
            AND (
              b.scope = 'network'
              OR EXISTS (
                SELECT 1 FROM ban_servers s
                 WHERE s.ban_id = b.id AND s.server_id = @server_id
              )
            )
          ORDER BY b.created_at DESC, b.id DESC`,
      )
      .all({ server_id: serverId }) as BanRow[];

    return this.#withServers(rows).filter((ban) => isActive(ban, now));
  }

  /**
   * Os bans que passaram da data e ninguém revogou ainda.
   *
   * É o que o relógio consome. Um ban vencido que continua no
   * `bans.cfg` é pior que não ter prazo: a pessoa cumpriu a pena e
   * continua fora, sem nada explicando por quê.
   */
  expired(now: number = Date.now()): readonly BanRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM bans
          WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= @now
          ORDER BY expires_at`,
      )
      .all({ now }) as BanRow[];

    return this.#withServers(rows);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Grava um banimento novo.
   *
   * A linha e os servidores dela numa transação só: um ban de
   * escopo `servers` que ficasse sem as linhas de `ban_servers`
   * seria um ban ativo que não vale em lugar nenhum — pior que a
   * falha, porque não parece falha.
   *
   * @throws quando já existe um ativo para aquele SteamID (o
   * `idx_bans_active` recusa). Quem traduz isso numa frase com o
   * ban anterior dentro é bans/service.ts.
   */
  create(input: BanInput, now: number = Date.now()): BanRecord {
    const insert = this.#db.transaction((): number => {
      const result = this.#db
        .prepare(
          `INSERT INTO bans
             (steam_id, name, reason, scope, created_at, created_by, expires_at, origin)
           VALUES
             (@steam_id, @name, @reason, @scope, @created_at, @created_by, @expires_at, @origin)`,
        )
        .run({
          steam_id: input.steamId,
          name: input.name,
          reason: input.reason,
          scope: input.scope,
          created_at: now,
          created_by: input.createdBy,
          expires_at: input.expiresAt,
          origin: input.origin,
        });

      const id = Number(result.lastInsertRowid);

      if (input.scope === 'servers') {
        const link = this.#db.prepare(
          'INSERT OR IGNORE INTO ban_servers (ban_id, server_id) VALUES (@ban_id, @server_id)',
        );

        for (const serverId of new Set(input.servers)) {
          link.run({ ban_id: id, server_id: serverId });
        }
      }

      return id;
    });

    const id = insert();
    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`o banimento de ${input.steamId} sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  /**
   * Faz um ban de escopo `servers` valer também naquele servidor.
   *
   * ####  ISTO É ADOÇÃO DE ALCANCE, E NÃO UM BAN NOVO  ####
   *
   * Acontece quando a reconciliação encontra, no `bans.cfg` do
   * `pvp2`, um SteamID que já tem banimento ativo restrito ao
   * `pvp1`. Criar um segundo ban seria impossível (o índice único
   * recusa) e errado (dois motivos para o mesmo jogador); apagar o
   * do servidor seria desfazer a decisão de alguém. Estender é a
   * única leitura que preserva as duas coisas.
   *
   * Não faz nada num ban `network`: ele já vale em todo servidor, e
   * enumerar um deles o transformaria no que ele existe para não
   * ser.
   */
  addServer(banId: number, serverId: string): void {
    const row = this.#db.prepare('SELECT scope FROM bans WHERE id = @id').get({ id: banId }) as
      | { readonly scope: string }
      | undefined;

    if (row === undefined || row.scope !== 'servers') {
      return;
    }

    this.#db
      .prepare('INSERT OR IGNORE INTO ban_servers (ban_id, server_id) VALUES (@ban_id, @server_id)')
      .run({ ban_id: banId, server_id: serverId });
  }

  /**
   * Marca como revogado o ban ativo daquele SteamID.
   *
   * A linha FICA (ver a migração 005). `null` = não havia ban
   * ativo, e quem chamou decide se isso é 404 ou silêncio.
   */
  revoke(steamId: string, revokedBy: string | null, now: number = Date.now()): BanRecord | null {
    const existing = this.activeOf(steamId);

    if (existing === null) {
      return null;
    }

    this.#db
      .prepare(
        `UPDATE bans
            SET revoked_at = @now, revoked_by = @revoked_by
          WHERE id = @id AND revoked_at IS NULL`,
      )
      .run({ id: existing.id, now, revoked_by: revokedBy });

    return this.get(existing.id);
  }

  /**
   * Os servidores de cada ban, numa consulta só.
   *
   * A listagem global faz essa pergunta por linha, e uma consulta
   * por ban seria trinta idas ao banco para desenhar uma tela —
   * a mesma razão do `activeServersByPlugin` em
   * plugins-repository.ts.
   */
  #withServers(rows: readonly BanRow[]): readonly BanRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const links = this.#db
      .prepare('SELECT ban_id, server_id FROM ban_servers ORDER BY ban_id, server_id')
      .all() as { readonly ban_id: number; readonly server_id: string }[];

    const byBan = new Map<number, string[]>();

    for (const link of links) {
      const list = byBan.get(link.ban_id);

      if (list === undefined) {
        byBan.set(link.ban_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toBanRecord(row, byBan.get(row.id) ?? []));
  }
}

/**
 * A linha crua vira registro.
 *
 * `scope` e `origin` chegam como `string` do SQLite. Quem garante
 * os valores é o `CHECK` da tabela — o estreitamento aqui só
 * reconhece isso para o TypeScript, e não substitui a trava.
 */
function toBanRecord(row: BanRow, servers: readonly string[]): BanRecord {
  return {
    id: row.id,
    steamId: row.steam_id,
    name: row.name,
    reason: row.reason,
    scope: row.scope === 'network' ? 'network' : 'servers',
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    origin: row.origin === 'adopted' ? 'adopted' : 'panel',
    servers,
  };
}
