// ============================================================
//  meta-repository.ts  -  a tabela key/value do agente.
//
//  Uma linha por chave, e a chave é o nome inteiro do fato:
//  `items.catalog.version`, `site.catalog.mirrored_version.server01`.
//  Prefixo por assunto, para que um `SELECT ... LIKE` mostre um
//  assunto de cada vez.
//
//  ####  ELE FOI EXTRAÍDO, E NÃO COPIADO  ####
//
//  As duas consultas já existiam como métodos PRIVADOS dentro do
//  `ItemsRepository`. Copiá-las para cá criaria duas verdades sobre
//  a mesma tabela — e a segunda seria a que esquece o `updated_at`.
//  O `ItemsRepository` passa a delegar.
//
//  A tabela nasceu na migração 001: nada aqui precisa de migração.
// ============================================================

import type { AgentDatabase } from './database.js';

export class MetaRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /** `null` = a chave nunca foi escrita. */
  read(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = @key').get({ key }) as
      | { readonly value: string }
      | undefined;

    return row === undefined ? null : row.value;
  }

  write(key: string, value: string, updatedAt: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value, updated_at)
              VALUES (@key, @value, @updated_at)
         ON CONFLICT (key) DO UPDATE SET
              value      = excluded.value,
              updated_at = excluded.updated_at`,
      )
      .run({ key, value, updated_at: updatedAt });
  }

  /**
   * Apaga a chave. Apagar o que não existe não é erro.
   *
   * Ela existe para o que é PENDÊNCIA, e não fato: o ACK de config
   * que o site ainda não confirmou fica gravado até passar, e
   * deixá-lo com uma string vazia obrigaria todo leitor a saber que
   * `''` quer dizer "nenhum" — o começo de dois significados para o
   * mesmo valor.
   */
  clear(key: string): void {
    this.#db.prepare('DELETE FROM meta WHERE key = @key').run({ key });
  }

  /**
   * Várias chaves numa transação só.
   *
   * A versão do espelho e o carimbo dela precisam entrar juntos: uma
   * queda entre as duas escritas deixaria o agente achando que
   * empurrou um catálogo numa hora que nunca existiu.
   */
  writeMany(entries: Readonly<Record<string, string>>, updatedAt: number = Date.now()): void {
    const write = this.#db.transaction((pairs: readonly [string, string][]) => {
      for (const [key, value] of pairs) {
        this.write(key, value, updatedAt);
      }
    });

    write(Object.entries(entries));
  }
}
