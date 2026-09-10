// ============================================================
//  betterloot-junk-repository.ts  -  o que é "lixo" no loot de
//  cada servidor.
//
//  ####  ISTO NÃO É CONFIGURAÇÃO DO PLUGIN  ####
//
//  O BetterLoot não conhece a palavra "junk": medido em
//  09/09/2026, `grep -i junk` no fonte v4.4.0 dá zero. A lista é
//  ferramenta de CURADORIA — o admin marca o que considera lixo, e
//  a tela usa isso para tirar esses itens de uma caixa de uma vez.
//  O que chega ao servidor é a caixa sem eles; a lista fica aqui.
//
//  É como o Looty faz, e é a única forma que sobrevive: o
//  `scanEntry` reescreve o `LootTables.json` a cada carregamento e
//  apagaria qualquer campo nosso guardado lá.
//
//  Ver Docs/CustomItem/08-ESTUDO-DO-LOOTY.md §3 e a migração 073.
//
//  ####  A TABELA GUARDA A DIVERGÊNCIA  ####
//
//  Os padrões estão logo abaixo, no código. A tabela só diz o que
//  o admin mudou — o que ele desligou e o que ele acrescentou. Ver
//  o cabeçalho da migração para por que não semeamos as 31 linhas.
// ============================================================

import type { AgentDatabase } from './database.js';

/**
 * Os itens que já nascem marcados como lixo.
 *
 * ####  DE ONDE ESTA LISTA SAIU  ####
 *
 * São os 31 padrões do editor Looty, capturados da tela dele em
 * 09/09/2026 (Docs/CustomItem/08 §3.2). Não são um palpite nosso:
 * é a curadoria de quem edita loot de Rust há anos, e ela é boa —
 * decoração, construção barata e roupa de pano, que enchem caixa
 * sem mover a progressão de ninguém.
 *
 * Nada aqui é irreversível: cada um pode ser desligado por
 * servidor, e a lista só age quando o admin clica em "remover
 * lixo".
 */
export const DEFAULT_JUNK_SHORTNAMES: readonly string[] = [
  'barricade.stone',
  'barricade.wood',
  'barricade.wood.cover',
  'bucket.water',
  'burlap.gloves',
  'electric.igniter',
  'fireplace.stone',
  'fun.guitar',
  'hat.beenie',
  'hat.boonie',
  'hat.cap',
  'mailbox',
  'mask.balaclava',
  'mask.bandana',
  'paddle',
  'pants.shorts',
  'planter.large',
  'planter.triangle',
  'rug',
  'rug.bear',
  'shelves',
  'shirt.tanktop',
  'shutter.wood.a',
  'sign.wooden.huge',
  'sign.wooden.large',
  'spikes.floor',
  'spinner.wheel',
  'table',
  'tool.binoculars',
  'tunalight',
  'water.barrel',
];

const DEFAULTS = new Set(DEFAULT_JUNK_SHORTNAMES);

/** Uma linha da lista, como a tela a mostra. */
export interface JunkItem {
  readonly shortname: string;
  /**
   * Veio da lista de fábrica?
   *
   * A tela separa os dois: o padrão desligado pode voltar, e o
   * acrescentado some de vez. São ações diferentes com o mesmo
   * ícone, e confundi-las apaga trabalho do admin.
   */
  readonly isDefault: boolean;
  readonly active: boolean;
}

interface JunkRow {
  readonly shortname: string;
  readonly active: number;
}

export class BetterLootJunkRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /**
   * A lista daquele servidor: os padrões e o que o admin somou.
   *
   * Sai ORDENADA e completa — inclusive os padrões desligados, que
   * a tela precisa mostrar apagados para poder religá-los.
   */
  list(serverId: string): readonly JunkItem[] {
    const rows = this.#db
      .prepare('SELECT shortname, active FROM betterloot_junk WHERE server_id = @server_id')
      .all({ server_id: serverId }) as JunkRow[];

    const overrides = new Map(rows.map((row) => [row.shortname, row.active === 1]));

    const items: JunkItem[] = DEFAULT_JUNK_SHORTNAMES.map((shortname) => ({
      shortname,
      isDefault: true,
      active: overrides.get(shortname) ?? true,
    }));

    for (const [shortname, active] of overrides) {
      // Só o que NÃO é padrão: o padrão já entrou acima, com o
      // estado que a linha diz.
      if (!DEFAULTS.has(shortname) && active) {
        items.push({ shortname, isDefault: false, active: true });
      }
    }

    return items.sort((a, b) => a.shortname.localeCompare(b.shortname));
  }

  /** Os shortnames que valem AGORA — o que o "remover lixo" usa. */
  activeOf(serverId: string): readonly string[] {
    return this.list(serverId)
      .filter((item) => item.active)
      .map((item) => item.shortname);
  }

  /**
   * Marca um item como lixo.
   *
   * Vale tanto para acrescentar um item novo quanto para RELIGAR um
   * padrão que o admin tinha desligado — as duas coisas são a mesma
   * linha com `active = 1`.
   */
  add(serverId: string, shortname: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO betterloot_junk (server_id, shortname, active, created_at)
         VALUES (@server_id, @shortname, 1, @created_at)
         ON CONFLICT (server_id, shortname) DO UPDATE SET active = 1`,
      )
      .run({ server_id: serverId, shortname, created_at: now });
  }

  /**
   * Tira um item da lista.
   *
   * ####  E AS DUAS METADES SÃO DIFERENTES  ####
   *
   * O acrescentado pelo admin some — a linha é apagada. O PADRÃO
   * não pode sumir: ele mora no código, e apagar a linha o traria
   * de volta na próxima leitura. Por isso ele vira uma linha com
   * `active = 0`, que é o registro de que alguém o desligou de
   * propósito.
   */
  remove(serverId: string, shortname: string, now: number): void {
    if (DEFAULTS.has(shortname)) {
      this.#db
        .prepare(
          `INSERT INTO betterloot_junk (server_id, shortname, active, created_at)
           VALUES (@server_id, @shortname, 0, @created_at)
           ON CONFLICT (server_id, shortname) DO UPDATE SET active = 0`,
        )
        .run({ server_id: serverId, shortname, created_at: now });

      return;
    }

    this.#db
      .prepare('DELETE FROM betterloot_junk WHERE server_id = @server_id AND shortname = @shortname')
      .run({ server_id: serverId, shortname });
  }
}
