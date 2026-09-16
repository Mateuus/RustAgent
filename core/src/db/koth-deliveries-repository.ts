// ============================================================
//  koth-deliveries-repository.ts  -  quem já recebeu o quê.
//
//  ####  ELE EXISTE PORQUE A ENTREGA NÃO É IDEMPOTENTE  ####
//
//  Das cinco recompensas, só duas se protegem sozinhas: o OZCoin
//  pela referência da carteira, o ponto de ranking pelo `eventId`.
//  Item, kit e VIP não têm nada disso — entregar duas vezes põe
//  duas AK na mão da mesma pessoa, e ninguém devolve.
//
//  Então a trava mora aqui: uma linha por (run, jogador, posição
//  da recompensa). Quem já tem linha não recebe de novo, e isso
//  vale mesmo que o mesmo aviso de captura chegue duas vezes — o
//  que acontece quando o plugin recarrega no meio de um evento.
//
//  ####  A FALHA TAMBÉM VIRA LINHA  ####
//
//  Guardar só o que deu certo faria o que deu errado sumir. A
//  linha com `ok = 0` carrega o código cru de quem entregou
//  (INVENTORY_FULL, RCON_UNAVAILABLE) — e é ela que responde "quem
//  ficou sem" quando alguém pergunta no dia seguinte.
//
//  ####  MAS A FALHA NÃO TRAVA A SEGUNDA TENTATIVA  ####
//
//  `alreadyPaid` só conta o que deu CERTO. Uma entrega que falhou
//  por inventário cheio pode sair de novo — é exatamente o caso em
//  que reentregar é a coisa certa, e a linha antiga fica como
//  registro do que aconteceu.
// ============================================================

import type { AgentDatabase } from './database.js';

export interface KothDelivery {
  readonly runId: number;
  readonly steamId: string;
  /** A POSIÇÃO da recompensa na lista do território. */
  readonly index: number;
  readonly ok: boolean;
  /** O código cru de quem entregou. `null` quando deu certo. */
  readonly code: string | null;
  readonly at: number;
}

interface Row {
  readonly run_id: number;
  readonly steam_id: string;
  readonly idx: number;
  readonly ok: number;
  readonly code: string | null;
  readonly at: number;
}

export class KothDeliveriesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /**
   * As posições que este jogador JÁ recebeu nesta run, de verdade.
   *
   * Só os sucessos: ver o cabeçalho.
   */
  alreadyPaid(runId: number, steamId: string): ReadonlySet<number> {
    const rows = this.#db
      .prepare('SELECT idx FROM koth_deliveries WHERE run_id = ? AND steam_id = ? AND ok = 1')
      .all(runId, steamId) as { readonly idx: number }[];

    return new Set(rows.map((row) => row.idx));
  }

  record(entry: Omit<KothDelivery, 'at'> & { readonly at?: number }): void {
    this.#db
      .prepare(
        `INSERT INTO koth_deliveries (run_id, steam_id, idx, ok, code, at)
         VALUES (@runId, @steamId, @idx, @ok, @code, @at)
         ON CONFLICT(run_id, steam_id, idx) DO UPDATE SET
           ok = excluded.ok,
           code = excluded.code,
           at = excluded.at`,
      )
      .run({
        runId: entry.runId,
        steamId: entry.steamId,
        idx: entry.index,
        ok: entry.ok ? 1 : 0,
        code: entry.code,
        at: entry.at ?? Date.now(),
      });
  }

  /** Tudo o que aconteceu numa run. O painel lê por aqui. */
  ofRun(runId: number): readonly KothDelivery[] {
    const rows = this.#db
      .prepare('SELECT * FROM koth_deliveries WHERE run_id = ? ORDER BY steam_id, idx')
      .all(runId) as Row[];

    return rows.map((row) => ({
      runId: row.run_id,
      steamId: row.steam_id,
      index: row.idx,
      ok: row.ok === 1,
      code: row.code,
      at: row.at,
    }));
  }
}
