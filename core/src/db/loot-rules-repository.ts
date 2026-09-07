// ============================================================
//  loot-rules-repository.ts  -  o que NÓS acrescentamos ao loot
//  que o jogo já põe na caixa.
//
//  ####  A REGRA COMPLEMENTA; ELA NUNCA SUBSTITUI  ####
//
//  O jogo popula o container normalmente e nós acrescentamos por
//  cima. Nada aqui — nem no plugin — reimplementa `FillLoot`,
//  `PopulateLoot` ou `GenerateScrap`. O motivo decisivo não é
//  segurança, é o update: a tabela do Rust são 1.396 entradas
//  alcançáveis que a Facepunch mantém de graça, e substituir é
//  assumir essa manutenção em silêncio. Ver
//  Docs/CustomItem/05-EDITOR-DE-LOOT.md §4.
//
//  A tabela e o porquê de cada coluna estão na migração 048.
//
//  ####  A MARCA NÃO MORA AQUI — ELA VEM DO `custom_items`  ####
//
//  MEDIDO em Docs/CustomItem/04 §4.1: a tabela de loot do Rust cria
//  todo item com `skin = 0`, e `ItemAmount` não tem campo de skin
//  para preencher. Item sem skin não é o nosso: o `Match` do plugin
//  sai em `item.skin == 0UL`, o nome não é aplicado, e o jogador
//  acha lixo.
//
//  Por isso a regra aponta para um item custom, e é dele que saem
//  o `base_shortname` e o `skin_id` que viajam até o plugin. Este
//  repositório os LÊ junto na consulta — sem eles a regra não tem
//  como ser aplicada, e descobrir isso dentro do jogo seria
//  descobrir tarde.
//
//  ####  A MEDIÇÃO É CONTADOR SOBRESCRITO, E NÃO FILA  ####
//
//  `recordHits` REESCREVE a linha do dia em vez de somar. O plugin
//  guarda o acumulado em disco e o agente o copia — ler duas vezes
//  dá o mesmo número, e uma leitura perdida se conserta sozinha na
//  volta seguinte. É o oposto da fila de pontos do `OrigemZItems`,
//  e de propósito: lá o item JÁ FOI DESTRUÍDO e o que se perde não
//  volta; aqui o que se perde é uma contagem que o plugin ainda
//  tem.
// ============================================================

import type { AgentDatabase } from './database.js';
import { slugify } from './custom-items-repository.js';

/** Os dois modos, e a diferença entre eles é a razão desta fatia. */
export const LOOT_RULE_MODES = ['measuring', 'live'] as const;

/**
 * `measuring` conta e NÃO cria; `live` cria.
 *
 * É a Q8 do `Docs/CustomItem/04`, respondida pelo dono: mede antes
 * de soltar. Sem uma semana de contagem, a probabilidade de partida
 * é um chute com fator de erro de 5 — o estudo não conseguiu medir
 * quantos containers nascem por dia neste servidor.
 */
export type LootRuleMode = (typeof LOOT_RULE_MODES)[number];

export interface LootRuleInput {
  readonly label: string;
  /** FK para `custom_items`. É daí que sai a marca. */
  readonly customItemId: string;
  /** Os `ShortPrefabName` — `crate_elite`, `heli_crate`. */
  readonly containers: readonly string[];
  /** Por container POPULADO. `0 < x <= 1`. */
  readonly chance: number;
  readonly amountMin: number;
  readonly amountMax: number;
  readonly mode: LootRuleMode;
  /** Teto por servidor por dia. `null` = sem teto. */
  readonly dailyCap: number | null;
  /** O portão da Via B. `null` = sem cooldown. */
  readonly playerCooldownHours: number | null;
  readonly enabled: boolean;
  readonly servers: readonly string[];
}

export interface LootRuleRecord extends LootRuleInput {
  readonly id: string;
  /**
   * A marca, lida do item custom.
   *
   * `null` nos três campos quando o item foi apagado entre a
   * consulta e a leitura — o `ON DELETE CASCADE` torna isso quase
   * impossível, e o `null` existe para que quem ler o tipo saiba
   * que a regra sem item não é aplicável.
   */
  readonly itemDisplayName: string | null;
  readonly itemBaseShortname: string | null;
  readonly itemSkinId: string | null;
  /** O item custom está ligado? Regra com item desligado não sobe. */
  readonly itemEnabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface LootRuleRow {
  readonly id: string;
  readonly label: string;
  readonly custom_item_id: string;
  readonly containers: string;
  readonly chance: number;
  readonly amount_min: number;
  readonly amount_max: number;
  readonly mode: string;
  readonly daily_cap: number | null;
  readonly player_cooldown_hours: number | null;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly item_display_name: string | null;
  readonly item_base_shortname: string | null;
  readonly item_skin_id: string | null;
  readonly item_enabled: number | null;
}

/** Uma contagem de um dia, como o plugin a entrega. */
export interface LootRuleHitInput {
  readonly ruleId: string;
  readonly serverId: string;
  /** `YYYY-MM-DD`, no fuso do SERVIDOR DE JOGO. Ver `recordHits`. */
  readonly day: string;
  readonly mode: LootRuleMode;
  /** Containers elegíveis que passaram pelo sorteio. */
  readonly rolls: number;
  /** Sorteios que deram positivo. */
  readonly hits: number;
  /** Itens que de fato nasceram. Em `measuring` é sempre 0. */
  readonly spawned: number;
  /** Jogadores barrados pelo portão do cooldown. */
  readonly blocked: number;
}

export interface LootRuleDayStat {
  readonly day: string;
  readonly rolls: number;
  readonly hits: number;
  readonly spawned: number;
  readonly blocked: number;
}

export interface LootRuleStats {
  readonly ruleId: string;
  readonly days: readonly LootRuleDayStat[];
  readonly total: LootRuleDayStat;
}

/** Quantos dias de histórico a tela de estatística mostra. */
export const DEFAULT_STATS_DAYS = 30;

const SELECT_COLUMNS = `
  SELECT r.*,
         c.display_name   AS item_display_name,
         c.base_shortname AS item_base_shortname,
         c.skin_id        AS item_skin_id,
         c.enabled        AS item_enabled
    FROM loot_rules r
    LEFT JOIN custom_items c ON c.id = r.custom_item_id`;

export class LootRulesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Todas, com os servidores de cada uma.
   *
   * Duas consultas, e não uma por regra: a tela que chama isto é
   * justamente a que lista tudo de uma vez, e perguntar "onde esta
   * vale?" por linha seria o N+1 clássico dela. Mesmo desenho do
   * `custom-items-repository`.
   */
  list(): readonly LootRuleRecord[] {
    const rows = this.#db
      .prepare(`${SELECT_COLUMNS} ORDER BY r.label COLLATE NOCASE ASC, r.id ASC`)
      .all() as LootRuleRow[];

    return this.#withServers(rows);
  }

  /**
   * As que valem naquele servidor — e é esta que alimenta o plugin.
   *
   * ####  TRÊS CONDIÇÕES, E CADA UMA JÁ MORDEU ESTE PROJETO  ####
   *
   *  1. a regra está ligada e vale naquele servidor;
   *  2. o item custom está LIGADO. Desligar um item no painel tem
   *     de parar de soltá-lo no mundo — senão o admin desliga o
   *     troféu e ele continua caindo do barril;
   *  3. o item custom vale NAQUELE servidor. Uma regra que
   *     apontasse para um item que não existe ali criaria um item
   *     que o plugin daquele servidor não reconhece: sem nome, sem
   *     ação, e o jogador achando lixo.
   *
   * A terceira é a que não se vê: as duas listas (`loot_rule_servers`
   * e `custom_item_servers`) são independentes, e nada impede o
   * admin de ligar a regra num servidor onde o item não vale.
   */
  listForServer(serverId: string): readonly LootRuleRecord[] {
    const rows = this.#db
      .prepare(
        `${SELECT_COLUMNS}
          JOIN loot_rule_servers s ON s.rule_id = r.id
          JOIN custom_item_servers cs
            ON cs.item_id = r.custom_item_id AND cs.server_id = @server_id
         WHERE s.server_id = @server_id
           AND r.enabled = 1
           AND c.enabled = 1
         ORDER BY r.label COLLATE NOCASE ASC, r.id ASC`,
      )
      .all({ server_id: serverId }) as LootRuleRow[];

    return this.#withServers(rows);
  }

  get(id: string): LootRuleRecord | null {
    const row = this.#db.prepare(`${SELECT_COLUMNS} WHERE r.id = @id`).get({ id }) as
      | LootRuleRow
      | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Cria a regra e a liga aos servidores, numa transação.
   *
   * As duas coisas juntas pelo mesmo motivo do item custom: uma
   * regra ligada a servidor nenhum não vale em lugar nenhum — e
   * isso não parece falha, que é o que a torna pior que uma falha.
   */
  create(input: LootRuleInput, now: number = Date.now()): LootRuleRecord {
    const id = this.#freeId(input.label);

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `INSERT INTO loot_rules
             (id, label, custom_item_id, containers, chance, amount_min, amount_max,
              mode, daily_cap, player_cooldown_hours, enabled, created_at, updated_at)
           VALUES
             (@id, @label, @custom_item_id, @containers, @chance, @amount_min, @amount_max,
              @mode, @daily_cap, @player_cooldown_hours, @enabled, @created_at, @updated_at)`,
        )
        .run({ id, ...toColumns(input), created_at: now, updated_at: now });

      this.#replaceServers(id, input.servers);
    });

    run();

    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`a regra de loot "${id}" sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Reescreve a regra inteira.
   *
   * PUT, e não PATCH, pela mesma razão do item custom: a tela edita
   * num formulário só e manda tudo, e um merge parcial abriria a
   * pergunta "o que acontece com os servidores que não vieram?".
   *
   * O `id` NÃO muda quando o rótulo muda — a medição já gravada
   * aponta para ele.
   */
  update(id: string, input: LootRuleInput, now: number = Date.now()): LootRuleRecord | null {
    if (this.get(id) === null) {
      return null;
    }

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE loot_rules SET
             label                 = @label,
             custom_item_id        = @custom_item_id,
             containers            = @containers,
             chance                = @chance,
             amount_min            = @amount_min,
             amount_max            = @amount_max,
             mode                  = @mode,
             daily_cap             = @daily_cap,
             player_cooldown_hours = @player_cooldown_hours,
             enabled               = @enabled,
             updated_at            = @updated_at
           WHERE id = @id`,
        )
        .run({ id, ...toColumns(input), updated_at: now });

      this.#replaceServers(id, input.servers);
    });

    run();

    return this.get(id);
  }

  /**
   * Apaga.
   *
   * A cascata leva as ligações de servidor e a MEDIÇÃO junto. É
   * deliberado: a contagem só faz sentido ao lado da chance e dos
   * containers que a produziram, e guardá-la órfã daria um número
   * sem denominador. Quem quer parar de emitir sem perder o
   * histórico desliga a regra em vez de apagá-la.
   */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM loot_rules WHERE id = @id').run({ id }).changes > 0;
  }

  // ------------------------------------------------------
  //  A medição
  // ------------------------------------------------------

  /**
   * Grava o que o plugin contou. SOBRESCREVE, e não soma.
   *
   * ####  POR QUE SOBRESCREVER É O CERTO AQUI  ####
   *
   * O plugin guarda o acumulado do dia em disco e o devolve
   * inteiro a cada leitura. Somar faria a segunda leitura do mesmo
   * minuto dobrar o número — e o relógio que lê é de 60 s, então
   * "duas leituras do mesmo estado" é o caso NORMAL, não a
   * exceção.
   *
   * Sobrescrever também torna a perda benigna: uma leitura que não
   * aconteceu se conserta sozinha na volta seguinte, porque o
   * número que o plugin guarda não é consumido pela leitura. É o
   * oposto da fila de pontos, e é o certo para um contador.
   *
   * O `day` chega PRONTO do jogo. Recalculá-lo aqui, com o fuso da
   * máquina do agente, faria o teto diário (que o plugin aplica) e
   * o gráfico (que sai daqui) virarem em horas diferentes — e a
   * pergunta "por que o teto de 3 rendeu 4?" não teria resposta.
   *
   * @returns quantas linhas foram escritas.
   */
  recordHits(entries: readonly LootRuleHitInput[], now: number = Date.now()): number {
    if (entries.length === 0) {
      return 0;
    }

    const upsert = this.#db.prepare(
      `INSERT INTO loot_rule_hits
         (rule_id, server_id, day, mode, rolls, hits, spawned, blocked, updated_at)
       VALUES
         (@rule_id, @server_id, @day, @mode, @rolls, @hits, @spawned, @blocked, @updated_at)
       ON CONFLICT (rule_id, server_id, day, mode) DO UPDATE SET
         rolls      = excluded.rolls,
         hits       = excluded.hits,
         spawned    = excluded.spawned,
         blocked    = excluded.blocked,
         updated_at = excluded.updated_at`,
    );

    // A regra pode ter sido apagada entre a leitura do plugin e
    // esta gravação — e a FK recusaria a linha inteira, derrubando
    // as outras que estavam boas. Conferir antes é o que faz uma
    // regra apagada custar uma linha ignorada, e não a rodada.
    const known = this.#db.prepare('SELECT 1 FROM loot_rules WHERE id = @id');

    const run = this.#db.transaction((): number => {
      let written = 0;

      for (const entry of entries) {
        if (known.get({ id: entry.ruleId }) === undefined) {
          continue;
        }

        upsert.run({
          rule_id: entry.ruleId,
          server_id: entry.serverId,
          day: entry.day,
          mode: entry.mode,
          rolls: entry.rolls,
          hits: entry.hits,
          spawned: entry.spawned,
          blocked: entry.blocked,
          updated_at: now,
        });

        written += 1;
      }

      return written;
    });

    return run();
  }

  /**
   * Quantas vezes a regra disparou (ou TERIA disparado), por dia.
   *
   * Os dois modos somam na mesma linha de dia: para quem lê o
   * gráfico, "teria disparado" e "disparou" são a mesma série — o
   * que muda é o `spawned`, que em `measuring` é zero por
   * construção.
   */
  statsOf(
    ruleId: string,
    options: { readonly serverId?: string; readonly days?: number } = {},
  ): LootRuleStats {
    const days = options.days ?? DEFAULT_STATS_DAYS;
    const serverId = options.serverId;

    const rows = this.#db
      .prepare(
        `SELECT day,
                sum(rolls)   AS rolls,
                sum(hits)    AS hits,
                sum(spawned) AS spawned,
                sum(blocked) AS blocked
           FROM loot_rule_hits
          WHERE rule_id = @rule_id
            AND (@server_id IS NULL OR server_id = @server_id)
          GROUP BY day
          ORDER BY day DESC
          LIMIT @limit`,
      )
      .all({ rule_id: ruleId, server_id: serverId ?? null, limit: days }) as {
      day: string;
      rolls: number;
      hits: number;
      spawned: number;
      blocked: number;
    }[];

    // A consulta desce (o dia de hoje primeiro, para o LIMIT pegar
    // os mais recentes) e a resposta sobe: um gráfico se lê da
    // esquerda para a direita.
    const list = rows.slice().reverse();

    const total = list.reduce<LootRuleDayStat>(
      (acc, row) => ({
        day: '',
        rolls: acc.rolls + row.rolls,
        hits: acc.hits + row.hits,
        spawned: acc.spawned + row.spawned,
        blocked: acc.blocked + row.blocked,
      }),
      { day: '', rolls: 0, hits: 0, spawned: 0, blocked: 0 },
    );

    return { ruleId, days: list, total };
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  #withServers(rows: readonly LootRuleRow[]): readonly LootRuleRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const byRule = new Map<string, string[]>();

    for (const link of this.#db
      .prepare('SELECT rule_id, server_id FROM loot_rule_servers ORDER BY rule_id, server_id')
      .all() as { rule_id: string; server_id: string }[]) {
      const list = byRule.get(link.rule_id);

      if (list === undefined) {
        byRule.set(link.rule_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toRecord(row, byRule.get(row.id) ?? []));
  }

  #replaceServers(ruleId: string, servers: readonly string[]): void {
    this.#db.prepare('DELETE FROM loot_rule_servers WHERE rule_id = @rule_id').run({
      rule_id: ruleId,
    });

    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO loot_rule_servers (rule_id, server_id) VALUES (@rule_id, @server_id)',
    );

    for (const serverId of new Set(servers)) {
      insert.run({ rule_id: ruleId, server_id: serverId });
    }
  }

  /**
   * Um `id` livre, derivado do rótulo.
   *
   * Mesmo desenho do item custom, e pelo mesmo motivo: o id viaja
   * num comando de console do Rust, onde espaço separa argumentos —
   * e "Troféu na caixa de elite" num log de madrugada diz mais que
   * um hash.
   */
  #freeId(label: string): string {
    const base = slugify(label);
    const exists = this.#db.prepare('SELECT 1 FROM loot_rules WHERE id = @id');

    if (exists.get({ id: base }) === undefined) {
      return base;
    }

    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`;

      if (exists.get({ id: candidate }) === undefined) {
        return candidate;
      }
    }

    throw new Error(`não achei um id livre para "${label}" — há 99 regras com esse nome?`);
  }
}

function toColumns(input: LootRuleInput): Record<string, unknown> {
  return {
    label: input.label,
    custom_item_id: input.customItemId,
    // A ordem é preservada e as repetições não: o admin marcando o
    // mesmo container duas vezes na tela dobraria a chance daquela
    // caixa sem nada dizer por quê.
    containers: JSON.stringify([...new Set(input.containers)]),
    chance: input.chance,
    amount_min: input.amountMin,
    amount_max: input.amountMax,
    mode: input.mode,
    daily_cap: input.dailyCap,
    player_cooldown_hours: input.playerCooldownHours,
    enabled: input.enabled ? 1 : 0,
  };
}

function toRecord(row: LootRuleRow, servers: readonly string[]): LootRuleRecord {
  return {
    id: row.id,
    label: row.label,
    customItemId: row.custom_item_id,
    containers: parseContainers(row.containers),
    chance: row.chance,
    amountMin: row.amount_min,
    amountMax: row.amount_max,
    mode: row.mode === 'live' ? 'live' : 'measuring',
    dailyCap: row.daily_cap,
    playerCooldownHours: row.player_cooldown_hours,
    enabled: row.enabled === 1,
    itemDisplayName: row.item_display_name,
    itemBaseShortname: row.item_base_shortname,
    itemSkinId: row.item_skin_id,
    itemEnabled: row.item_enabled === 1,
    servers,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A coluna JSON vira lista.
 *
 * JSON quebrado vira lista VAZIA em vez de estourar, e uma regra
 * sem container não dispara em lugar nenhum — que é o desfecho
 * seguro. Derrubar a listagem inteira por causa de uma linha
 * esconderia as outras trinta que estão boas; mesma escolha do
 * `parseAction` do item custom.
 */
function parseContainers(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Ver o comentário acima.
  }

  return [];
}
