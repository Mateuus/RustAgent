// ============================================================
//  team-ranks-repository.ts  -  o cargo, que o Rust não tem.
//
//  ####  A MENOR TABELA POSSÍVEL, DE PROPÓSITO  ####
//
//  Tudo que o jogo sabe responder fica no jogo. Aqui mora uma linha
//  por pessoa promovida — e a maioria das equipes não tem nenhuma.
//
//  ####  APAGAR É PARTE DO CONTRATO, NÃO MANUTENÇÃO  ####
//
//  Regra do dono (15/09/2026): equipe desfeita apaga tudo daquela
//  equipe. `forgetTeam` é chamado pelo `OnTeamDisbanded`, e o
//  `forgetMissing` do boot varre o que sobrou de um agente que
//  estava fora na hora em que a equipe acabou.
//
//  Sem os dois, um wipe (que zera o contador de equipes do jogo)
//  faria o cargo de uma equipe morta reaparecer na equipe que
//  herdasse aquele número. Ver a migração 088.
// ============================================================

import { GRANTABLE_RANKS, type GrantableRank, type TeamRankRow } from '../types/teams.js';
import type { AgentDatabase } from './database.js';

interface Row {
  readonly server_id: string;
  readonly team_id: string;
  readonly steam_id: string;
  readonly rank: string;
  readonly granted_by: string;
  readonly created_at: number;
  readonly updated_at: number;
}

function toRow(row: Row): TeamRankRow {
  return {
    serverId: row.server_id,
    teamId: row.team_id,
    steamId: row.steam_id,
    rank: row.rank,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TeamRanksRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /** Os cargos de um servidor inteiro. É uma tabela pequena. */
  list(serverId: string): readonly TeamRankRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM team_ranks WHERE server_id = ? ORDER BY team_id, steam_id')
      .all(serverId) as Row[];

    return rows.map(toRow);
  }

  ofTeam(serverId: string, teamId: string): readonly TeamRankRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM team_ranks WHERE server_id = ? AND team_id = ? ORDER BY steam_id')
      .all(serverId, teamId) as Row[];

    return rows.map(toRow);
  }

  /**
   * O cargo de uma pessoa naquela equipe.
   *
   * `null` = ela não foi promovida, que é o estado da maioria. Quem
   * chama traduz isso para `member` — o padrão não mora no banco,
   * ele mora em quem lê.
   */
  of(serverId: string, teamId: string, steamId: string): TeamRankRow | null {
    const row = this.#db
      .prepare('SELECT * FROM team_ranks WHERE server_id = ? AND team_id = ? AND steam_id = ?')
      .get(serverId, teamId, steamId) as Row | undefined;

    return row === undefined ? null : toRow(row);
  }

  /**
   * Promove (ou rebaixa).
   *
   * `member` APAGA a linha em vez de gravá-la: a ausência já quer
   * dizer membro, e guardar as duas formas do mesmo estado é o jeito
   * de um dia a tela mostrar coisas diferentes para o mesmo caso.
   */
  set(input: {
    readonly serverId: string;
    readonly teamId: string;
    readonly steamId: string;
    readonly rank: GrantableRank;
    readonly grantedBy?: string;
  }): void {
    if (input.rank === 'member') {
      this.clear(input.serverId, input.teamId, input.steamId);
      return;
    }

    const now = Date.now();

    this.#db
      .prepare(
        `INSERT INTO team_ranks (server_id, team_id, steam_id, rank, granted_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (server_id, team_id, steam_id)
         DO UPDATE SET rank = excluded.rank, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
      )
      .run(
        input.serverId,
        input.teamId,
        input.steamId,
        input.rank,
        input.grantedBy ?? '',
        now,
        now,
      );
  }

  clear(serverId: string, teamId: string, steamId: string): void {
    this.#db
      .prepare('DELETE FROM team_ranks WHERE server_id = ? AND team_id = ? AND steam_id = ?')
      .run(serverId, teamId, steamId);
  }

  /** A equipe acabou. Ver o cabeçalho: isto é contrato. */
  forgetTeam(serverId: string, teamId: string): number {
    const result = this.#db
      .prepare('DELETE FROM team_ranks WHERE server_id = ? AND team_id = ?')
      .run(serverId, teamId);

    return result.changes;
  }

  /**
   * Varre o que não existe mais no jogo.
   *
   * Chamado depois de uma leitura COMPLETA das equipes daquele
   * servidor — e só assim: com uma lista parcial, isto apagaria
   * cargo de equipe viva. Por isso `known` é a lista inteira, e a
   * função não tem como ser chamada com "as que eu vi por acaso".
   */
  forgetMissing(serverId: string, known: readonly string[]): number {
    if (known.length === 0) {
      const all = this.#db
        .prepare('DELETE FROM team_ranks WHERE server_id = ?')
        .run(serverId);

      return all.changes;
    }

    const marks = known.map(() => '?').join(', ');
    const result = this.#db
      .prepare(`DELETE FROM team_ranks WHERE server_id = ? AND team_id NOT IN (${marks})`)
      .run(serverId, ...known);

    return result.changes;
  }

  /**
   * A pessoa saiu da equipe.
   *
   * O cargo é DAQUELA equipe: quem sai e volta volta como membro.
   * Guardar o cargo de quem saiu faria alguém recuperar o posto
   * batendo na porta de novo — e ninguém entenderia por quê.
   */
  forgetMember(serverId: string, steamId: string): number {
    const result = this.#db
      .prepare('DELETE FROM team_ranks WHERE server_id = ? AND steam_id = ?')
      .run(serverId, steamId);

    return result.changes;
  }

  /** Só para o teste e para o painel: quantas linhas existem. */
  count(serverId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS total FROM team_ranks WHERE server_id = ?')
      .get(serverId) as { readonly total: number } | undefined;

    return row?.total ?? 0;
  }
}

/** O cargo que uma linha do banco representa, já validado. */
export function asGrantableRank(value: string): GrantableRank | null {
  return (GRANTABLE_RANKS as readonly string[]).includes(value) ? (value as GrantableRank) : null;
}

// ------------------------------------------------------------
//  A CONFIGURAÇÃO DE EQUIPE
// ------------------------------------------------------------

/**
 * O padrão do jogo, num lugar só.
 *
 * Oito é o `maxTeamSize_Internal` do Rust, medido no
 * Assembly-CSharp de 15/09/2026. Sem linha na tabela, é isto que
 * vale — e é isto que a tela mostra.
 */
export const DEFAULT_TEAM_SETTINGS: TeamSettings = { maxSize: 8 };

export interface TeamSettings {
  /** Quantos cabem numa equipe. 0 = equipes desligadas no Rust. */
  readonly maxSize: number;
}

export class TeamSettingsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  of(serverId: string): TeamSettings {
    const row = this.#db
      .prepare('SELECT max_size FROM team_settings WHERE server_id = ?')
      .get(serverId) as { readonly max_size: number } | undefined;

    return row === undefined ? DEFAULT_TEAM_SETTINGS : { maxSize: row.max_size };
  }

  save(serverId: string, settings: TeamSettings): TeamSettings {
    this.#db
      .prepare(
        `INSERT INTO team_settings (server_id, max_size, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (server_id) DO UPDATE SET max_size = excluded.max_size, updated_at = excluded.updated_at`,
      )
      .run(serverId, settings.maxSize, Date.now());

    return this.of(serverId);
  }

  /** Os servidores que têm configuração própria. É o que o boot reaplica. */
  configured(): readonly { readonly serverId: string; readonly maxSize: number }[] {
    const rows = this.#db
      .prepare('SELECT server_id, max_size FROM team_settings')
      .all() as { readonly server_id: string; readonly max_size: number }[];

    return rows.map((row) => ({ serverId: row.server_id, maxSize: row.max_size }));
  }
}
