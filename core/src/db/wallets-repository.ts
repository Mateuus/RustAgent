// ============================================================
//  wallets-repository.ts  -  o saldo e o extrato, no banco do
//  agente.
//
//  ####  ISTO É A CARTEIRA LOCAL, E ELA É UMA DAS DUAS  ####
//
//  A outra é a do site externo. Quem escolhe é `store/wallet.ts`,
//  uma vez, na inicialização — este arquivo não sabe que a outra
//  existe.
//
//  ------------------------------------------------------------
//  ####  A CHECAGEM E A ESCRITA SÃO A MESMA TRANSAÇÃO  ####
//
//  Ler o saldo, decidir e escrever em passos separados deixa uma
//  janela entre a leitura e a escrita — e dois débitos simultâneos
//  passariam os dois pela checagem, deixando o saldo negativo. Aqui
//  os dois acontecem juntos, e o segundo vê o que o primeiro
//  escreveu.
//
//  ####  INTEIRO, SEMPRE  ####
//
//  OZCoin não tem centavo. Saldo em float é como um débito de 10
//  vira 9,999999 e o jogador fica com 0,000001 de troco que a tela
//  arredonda para zero.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Uma linha do extrato. */
export interface WalletEntry {
  /**
   * Numerado pelo banco, e é ele que dá a ORDEM.
   *
   * Débito e estorno de uma compra que falha rápido caem no mesmo
   * milissegundo — sem um desempate estável, o extrato os mostraria
   * fora de ordem, e a coluna "saldo depois" deixaria de fazer
   * sentido. Ver a migração 018.
   */
  readonly id: number;
  /** A VARIAÇÃO: negativa no débito. */
  readonly amount: number;
  /** O saldo DEPOIS dela. */
  readonly balance: number;
  readonly reason: string;
  /** O que liga o lançamento à compra. `null` = ajuste avulso. */
  readonly reference: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
}

interface EntryRow {
  readonly id: number;
  readonly amount: number;
  readonly balance: number;
  readonly reason: string;
  readonly reference: string | null;
  readonly created_at: number;
}

export class WalletsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  getBalance(steamId: string): number {
    const row = this.#db
      .prepare(`SELECT balance FROM wallets WHERE steam_id = @steamId`)
      .get({ steamId }) as { readonly balance: number } | undefined;

    // Sem linha = saldo zero. Não é erro: todo jogador começa sem
    // OZCoin, e criar linha só para dizer "zero" encheria a tabela
    // com quem nunca comprou nada.
    return row?.balance ?? 0;
  }

  /**
   * Aplica a variação e devolve o saldo novo.
   *
   * `null` = não havia saldo suficiente. Ver o cabeçalho para por
   * que a checagem mora dentro da transação.
   */
  change(
    steamId: string,
    amount: number,
    reference: string | null,
    reason: string,
    now = Date.now(),
  ): number | null {
    const apply = this.#db.transaction((): number | null => {
      const current = this.getBalance(steamId);
      const next = current + Math.trunc(amount);

      if (next < 0) {
        return null;
      }

      this.#db
        .prepare(
          `INSERT INTO wallets (steam_id, balance, updated_at)
           VALUES (@steamId, @balance, @now)
           ON CONFLICT(steam_id) DO UPDATE SET
             balance    = excluded.balance,
             updated_at = excluded.updated_at`,
        )
        .run({ steamId, balance: next, now });

      // O extrato. Sem ele, "eu tinha 500 e agora tenho 200" não tem
      // resposta — e essa pergunta chega no primeiro dia.
      this.#db
        .prepare(
          `INSERT INTO wallet_entries
             (steam_id, amount, balance, reason, reference, created_at)
           VALUES (@steamId, @amount, @balance, @reason, @reference, @now)`,
        )
        .run({
          // O id é do BANCO, e não derivado da referência: débito e
          // estorno da mesma compra compartilham a referência e
          // colidiriam — deixando o jogador sem o item E sem o
          // dinheiro. Ver as migrações 016 e 018.
          steamId,
          amount: Math.trunc(amount),
          balance: next,
          reason,
          reference,
          now,
        });

      return next;
    });

    return apply();
  }

  listEntries(steamId: string, limit = 50): readonly WalletEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT id, amount, balance, reason, reference, created_at
           FROM wallet_entries
          WHERE steam_id = @steamId
          ORDER BY created_at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ steamId, limit }) as EntryRow[];

    return rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      balance: row.balance,
      reason: row.reason,
      reference: row.reference,
      createdAt: row.created_at,
    }));
  }
}
