// ============================================================
//  quests-repository.ts  -  as quests, do lado do banco.
//
//  ####  ELE GUARDA QUATRO COISAS QUE PARECEM UMA  ####
//
//    1. o CATÁLOGO (`quests`, `quest_objectives`, `quest_rewards`,
//       `quest_servers`) — o que existe para ser feito;
//    2. a TENTATIVA (`player_quests`) — quem está fazendo o quê,
//       e em que estado;
//    3. o CONTADOR (`player_quest_progress`) — quanto falta;
//    4. o que ACONTECEU (`quest_events`, `quest_batches`) — a
//       auditoria e a idempotência.
//
//  ------------------------------------------------------------
//  ####  AQUI NÃO SE DECIDE NADA: SÓ SE GUARDA  ####
//
//  Cooldown, cadeia, teto de quests ativas, "ele já pode aceitar?",
//  "os objetivos fecharam?" e a frase que o jogador lê moram em
//  `quests/service.ts`. Este arquivo é SQL.
//
//  A regra em uma frase: **quem chama o `accept` já decidiu que
//  pode**. O repositório calcula o `attempt` — que é aritmética de
//  banco, não regra — e grava.
//
//  Quem quiser saber por que uma COLUNA existe lê a migração 046 /
//  047; quem quiser saber por que uma REGRA existe lê o serviço.
//
//  ------------------------------------------------------------
//  ####  O SNAPSHOT É A FONTE DA VERDADE DE UMA TENTATIVA  ####
//
//  `player_quests.snapshot` congela o que a quest exigia e
//  prometia no aceite. A leitura de uma tentativa NUNCA relê
//  `quest_objectives`: uma quest editada no meio mudaria o alvo de
//  quem já estava jogando, e uma apagada apagaria a tentativa por
//  cascata sem que ninguém pedisse.
//
//  É a mesma razão do `DeliveryPlan` da loja — e aqui é pior, que
//  a compra leva segundos e uma diária aceita às 8h é resgatada às
//  23h.
//
//  ------------------------------------------------------------
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §3, §4 e §9.
// ============================================================

import { ApiError } from '../http/error-response.js';
import {
  DEFAULT_QUEST_SETTINGS,
  type PlayerQuestStatus,
  type QuestEventKind,
  type QuestEventSource,
  type QuestInput,
  type QuestNpcInput,
  type QuestNpcKind,
  type QuestNpcWipePolicy,
  type QuestObjective,
  type QuestObjectiveKind,
  type QuestRepeatMode,
  type QuestReward,
  type QuestRewardKind,
  type QuestSettings,
  type QuestSettingsInput,
  type QuestSnapshot,
  type QuestWipePolicy,
} from '../types/quests.js';
import type { AgentDatabase } from './database.js';

// ------------------------------------------------------------
//  §1  OS TIPOS DO DOMÍNIO
// ------------------------------------------------------------

/** A quest inteira, como sai do banco. */
export interface QuestRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string;
  readonly enabled: boolean;
  readonly sort: number;
  readonly requires: string | null;
  readonly npcId: string | null;
  readonly repeatMode: QuestRepeatMode;
  readonly cooldownSeconds: number;
  readonly requiresQuest: string | null;
  readonly availableFrom: number | null;
  readonly availableTo: number | null;
  readonly autoAccept: boolean;
  readonly wipePolicy: QuestWipePolicy;
  /** Vazia = vale em TODOS os servidores. Ver a migração 046. */
  readonly servers: readonly string[];
  readonly objectives: readonly QuestObjective[];
  readonly rewards: readonly QuestReward[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Uma tentativa, com o contador de cada objetivo. */
export interface PlayerQuestRecord {
  readonly id: number;
  readonly serverId: string;
  readonly steamId: string;
  readonly questId: string;
  readonly attempt: number;
  readonly status: PlayerQuestStatus;
  readonly acceptedAt: number;
  readonly completedAt: number | null;
  readonly claimedAt: number | null;
  readonly cooldownUntil: number | null;
  /** O que valia no aceite. Ver o cabeçalho. */
  readonly snapshot: QuestSnapshot;
  /** `objective_seq` → quanto já foi feito. */
  readonly progress: Readonly<Record<number, number>>;
}

export interface QuestNpcRecord extends QuestNpcInput {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Uma linha da auditoria. */
export interface QuestEventRecord {
  readonly id: number;
  readonly eventId: string | null;
  readonly serverId: string;
  readonly steamId: string;
  readonly questId: string;
  readonly attempt: number;
  readonly kind: QuestEventKind;
  readonly detail: unknown;
  readonly source: QuestEventSource;
  readonly actor: string | null;
  readonly at: number;
}

export interface QuestEventInput {
  /** `null` quando o evento nasce no agente. Ver a migração 046. */
  readonly eventId?: string | null;
  readonly serverId: string;
  readonly steamId: string;
  readonly questId: string;
  readonly attempt: number;
  readonly kind: QuestEventKind;
  readonly detail?: unknown;
  readonly source: QuestEventSource;
  readonly actor?: string | null;
}

/** Um avanço, como o lote do plugin o traz. */
export interface QuestProgressEntry {
  readonly playerQuestId: number;
  readonly objectiveSeq: number;
  /** Sempre DELTA, nunca total: o repositório SOMA o que chega. */
  readonly delta: number;
}

/** O lote de progresso, no desenho do `stat_batches`. */
export interface QuestBatchInput {
  readonly serverId: string;
  readonly batchId: string;
  readonly entries: readonly QuestProgressEntry[];
}

export interface ApplyQuestBatchResult {
  /** `false` = este `batchId` já tinha sido aplicado. */
  readonly applied: boolean;
  readonly entriesApplied: number;
  readonly playersTouched: number;
}

/** O que o `origemz.quest.watch` precisa saber. Ver §8.2 do plano. */
export interface WatchEntry {
  readonly kind: QuestObjectiveKind;
  readonly target: string;
}

export interface QuestWipeInput {
  readonly serverId?: string;
  readonly questId?: string;
  readonly steamId?: string;
  readonly actor: string;
  readonly reason: string;
}

// ------------------------------------------------------------
//  §2  AS LINHAS CRUAS
// ------------------------------------------------------------

interface QuestRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string;
  readonly enabled: number;
  readonly sort: number;
  readonly requires: string | null;
  readonly npc_id: string | null;
  readonly repeat_mode: string;
  readonly cooldown_seconds: number;
  readonly requires_quest: string | null;
  readonly available_from: number | null;
  readonly available_to: number | null;
  readonly auto_accept: number;
  readonly wipe_policy: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ObjectiveRow {
  readonly quest_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly target: string | null;
  readonly metric: string | null;
  readonly amount: number;
  readonly label: string | null;
  readonly consume: number;
}

interface RewardRow {
  readonly quest_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: string;
}

interface PlayerQuestRow {
  readonly id: number;
  readonly server_id: string;
  readonly steam_id: string;
  readonly quest_id: string;
  readonly attempt: number;
  readonly status: string;
  readonly accepted_at: number;
  readonly completed_at: number | null;
  readonly claimed_at: number | null;
  readonly cooldown_until: number | null;
  readonly snapshot: string;
}

interface NpcRow {
  readonly id: string;
  readonly server_id: string;
  readonly name: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotation: number;
  readonly prefab: string;
  readonly map_marker: number;
  readonly use_radius: number;
  readonly enabled: number;
  readonly wipe_policy: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface EventRow {
  readonly id: number;
  readonly event_id: string | null;
  readonly server_id: string;
  readonly steam_id: string;
  readonly quest_id: string;
  readonly attempt: number;
  readonly kind: string;
  readonly detail: string | null;
  readonly source: string;
  readonly actor: string | null;
  readonly at: number;
}

interface SettingsRow {
  readonly max_active: number;
  readonly enabled: number;
  readonly flush_seconds: number;
  readonly loot_enabled: number;
  readonly reset_at_minute: number;
  readonly updated_at: number;
}

// ------------------------------------------------------------
//  §3  SQL QUE SE REPETE
// ------------------------------------------------------------

/**
 * O jogador precisa existir antes da tentativa.
 *
 * A FK de `player_quests` para `players` cobra isso, e pagá-la
 * errado derrubaria o lote de TODO MUNDO por causa de um
 * recém-chegado — a lição que o `rankings-repository` já pagou.
 */
const ENSURE_PLAYER = `
INSERT OR IGNORE INTO players (steam_id, name, first_seen, last_seen, last_ip, created_at, updated_at)
     VALUES (@steam_id, @name, @at, @at, NULL, @at, @at)
`;

/**
 * O contador sobe SOMANDO, nunca substituindo.
 *
 * Um lote com totais em vez de deltas reescreveria o progresso a
 * cada minuto — e um lote reenviado (que é o caso normal deste
 * desenho) apagaria o que veio depois dele.
 */
const BUMP_PROGRESS = `
INSERT INTO player_quest_progress (player_quest_id, objective_seq, value, updated_at)
     VALUES (@player_quest_id, @objective_seq, @delta, @at)
ON CONFLICT (player_quest_id, objective_seq) DO UPDATE SET
     value      = player_quest_progress.value + @delta,
     updated_at = @at
`;

// ------------------------------------------------------------
//  §4  O REPOSITÓRIO
// ------------------------------------------------------------

export class QuestsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ======================================================
  //  O CATÁLOGO — leitura
  // ======================================================

  /**
   * Todas, com objetivos, recompensas e servidores de cada uma.
   *
   * ####  QUATRO CONSULTAS, E NÃO QUATRO POR QUEST  ####
   *
   * A lista e as três tabelas filhas, inteiras, casadas em
   * memória. Perguntar "quais são os objetivos desta?" por linha
   * seria o N+1 clássico da tela que lista tudo de uma vez — e é
   * justamente a tela do catálogo do painel.
   */
  list(): readonly QuestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM quests
          ORDER BY sort ASC, title COLLATE NOCASE ASC, id ASC`,
      )
      .all() as QuestRow[];

    return this.#hydrate(rows);
  }

  get(id: string): QuestRecord | null {
    const row = this.#db.prepare('SELECT * FROM quests WHERE id = @id').get({ id }) as
      | QuestRow
      | undefined;

    return row === undefined ? null : (this.#hydrate([row])[0] ?? null);
  }

  /**
   * As que valem NAQUELE servidor, e só as ligadas.
   *
   * É esta a consulta que alimenta a tela do jogo e o catálogo que
   * desce ao plugin. A ausência de linha em `quest_servers`
   * significa "vale em todos" — daí o `NOT EXISTS`, e não um
   * `JOIN`: com `JOIN`, a quest sem restrição nenhuma (que é a
   * maioria) sumiria de todos os servidores.
   */
  listForServer(serverId: string): readonly QuestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT q.* FROM quests q
          WHERE q.enabled = 1
            AND (
              NOT EXISTS (SELECT 1 FROM quest_servers s WHERE s.quest_id = q.id)
              OR EXISTS (SELECT 1 FROM quest_servers s
                          WHERE s.quest_id = q.id AND s.server_id = @server_id)
            )
          ORDER BY q.sort ASC, q.title COLLATE NOCASE ASC, q.id ASC`,
      )
      .all({ server_id: serverId }) as QuestRow[];

    return this.#hydrate(rows);
  }

  /** As categorias que existem, com quantas quests cada uma tem. */
  categories(): readonly { readonly category: string; readonly total: number }[] {
    return this.#db
      .prepare(
        `SELECT category, count(*) AS total
           FROM quests
          GROUP BY category
          ORDER BY category COLLATE NOCASE ASC`,
      )
      .all() as { category: string; total: number }[];
  }

  /**
   * O catálogo do `origemz.quest.watch`: os pares (kind, target)
   * que aquele servidor precisa observar.
   *
   * ####  SÓ O QUE PASSA PELO PLUGIN, E SÓ O QUE ESTÁ LIGADO  ####
   *
   * `playtime` e `metric` ficam de fora porque o agente os calcula
   * sozinho, do lote que o ranking já traz; `deliver` fica porque o
   * plugin precisa saber que aquele NPC é destino de alguma coisa.
   *
   * Uma lista vazia de `loot` é o que faz o plugin NÃO REGISTRAR o
   * hook mais quente do jogo — ver §5.4 do plano. Por isso ela é
   * calculada aqui, e não filtrada depois: quem chama precisa
   * poder confiar que "não veio" quer dizer "não observe".
   */
  watchFor(serverId: string): readonly WatchEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT o.kind, o.target
           FROM quest_objectives o
           JOIN quests q ON q.id = o.quest_id
          WHERE q.enabled = 1
            AND o.target IS NOT NULL
            AND o.kind IN ('kill','gather','craft','loot','deliver')
            AND (
              NOT EXISTS (SELECT 1 FROM quest_servers s WHERE s.quest_id = q.id)
              OR EXISTS (SELECT 1 FROM quest_servers s
                          WHERE s.quest_id = q.id AND s.server_id = @server_id)
            )
          ORDER BY o.kind ASC, o.target ASC`,
      )
      .all({ server_id: serverId }) as { kind: string; target: string }[];

    return rows.map((row) => ({ kind: row.kind as QuestObjectiveKind, target: row.target }));
  }

  /**
   * Quantos jogadores estão com esta quest viva AGORA.
   *
   * É o número que a rota mostra antes de deixar apagar
   * (`QUEST_IN_USE`): apagar uma quest leva por cascata o progresso
   * de quem está no meio dela, e quem clica precisa ver quantos são.
   */
  liveCountOf(questId: string): number {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS total FROM player_quests
          WHERE quest_id = @quest_id AND status IN ('active','completed')`,
      )
      .get({ quest_id: questId }) as { total: number };

    return row.total;
  }

  // ======================================================
  //  O CATÁLOGO — escrita
  // ======================================================

  /**
   * Cria a quest com objetivos, recompensas e servidores, numa
   * transação.
   *
   * As quatro coisas juntas porque uma quest sem objetivo não é
   * uma quest — e ela apareceria na tela do jogo como algo que
   * conclui sozinho.
   *
   * @throws `QUEST_ID_TAKEN` quando o slug já existe. O id é
   * escolhido por quem chama (a rota o deriva do título) porque
   * ele atravessa para a URL do painel e para o endereço da tela
   * do jogo — e um `-2` silencioso ali confundiria mais do que
   * ajudaria.
   */
  create(id: string, input: QuestInput, now: number = Date.now()): QuestRecord {
    if (this.get(id) !== null) {
      throw new ApiError('QUEST_ID_TAKEN', `Já existe uma quest com o id "${id}".`, 409);
    }

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `INSERT INTO quests
             (id, title, description, category, enabled, sort, requires, npc_id,
              repeat_mode, cooldown_seconds, requires_quest, available_from, available_to,
              auto_accept, wipe_policy, created_at, updated_at)
           VALUES
             (@id, @title, @description, @category, @enabled, @sort, @requires, @npc_id,
              @repeat_mode, @cooldown_seconds, @requires_quest, @available_from, @available_to,
              @auto_accept, @wipe_policy, @created_at, @updated_at)`,
        )
        .run({ id, ...toQuestColumns(input), created_at: now, updated_at: now });

      this.#replaceChildren(id, input);
    });

    run();

    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`a quest "${id}" sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Reescreve a quest inteira.
   *
   * PUT, e não PATCH: a tela edita num formulário só e manda tudo.
   * Um merge parcial abriria "o que acontece com os objetivos que
   * não vieram?", e a única resposta segura seria não mexer — o
   * oposto do que espera quem apagou um na tela.
   *
   * ####  E ISTO NÃO MEXE EM QUEM JÁ ESTÁ JOGANDO  ####
   *
   * As tentativas vivas leem o `snapshot` delas, congelado no
   * aceite. Editar a quest muda o que os PRÓXIMOS vão pegar, e
   * nada mais. É o que permite corrigir um alvo errado sem quebrar
   * quarenta jogadores no meio do caminho.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: string, input: QuestInput, now: number = Date.now()): QuestRecord | null {
    if (this.get(id) === null) {
      return null;
    }

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE quests SET
             title            = @title,
             description      = @description,
             category         = @category,
             enabled          = @enabled,
             sort             = @sort,
             requires         = @requires,
             npc_id           = @npc_id,
             repeat_mode      = @repeat_mode,
             cooldown_seconds = @cooldown_seconds,
             requires_quest   = @requires_quest,
             available_from   = @available_from,
             available_to     = @available_to,
             auto_accept      = @auto_accept,
             wipe_policy      = @wipe_policy,
             updated_at       = @updated_at
           WHERE id = @id`,
        )
        .run({ id, ...toQuestColumns(input), updated_at: now });

      this.#replaceChildren(id, input);
    });

    run();

    return this.get(id);
  }

  /**
   * Apaga.
   *
   * A cascata leva objetivos, recompensas, ligações de servidor —
   * e TODAS as tentativas, com o progresso e nada de aviso. Quem
   * pergunta quantos jogadores isso derruba antes de deixar apagar
   * é a rota, com o `liveCountOf`.
   */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM quests WHERE id = @id').run({ id }).changes > 0;
  }

  /**
   * Reordena o catálogo inteiro.
   *
   * A lista chega na ordem nova e o índice vira o `sort`. Ids que
   * não existem são ignorados em silêncio: a tela pode ter sido
   * carregada antes de alguém apagar uma quest noutra aba, e
   * derrubar a reordenação inteira por causa disso custaria ao
   * usuário o arrasto que ele acabou de fazer.
   *
   * @returns quantas linhas mudaram de lugar.
   */
  reorder(ids: readonly string[], now: number = Date.now()): number {
    const statement = this.#db.prepare(
      'UPDATE quests SET sort = @sort, updated_at = @at WHERE id = @id',
    );

    const run = this.#db.transaction((): number => {
      let changed = 0;

      ids.forEach((id, index) => {
        changed += statement.run({ id, sort: index, at: now }).changes;
      });

      return changed;
    });

    return run();
  }

  // ======================================================
  //  AS TENTATIVAS
  // ======================================================

  /**
   * As tentativas VIVAS de um jogador naquele servidor.
   *
   * É a consulta da tela do jogo e a que monta o
   * `origemz.quest.assign`. Usa o índice parcial
   * `idx_player_quests_live`.
   */
  liveFor(serverId: string, steamId: string): readonly PlayerQuestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM player_quests
          WHERE server_id = @server_id AND steam_id = @steam_id
            AND status IN ('active','completed')
          ORDER BY accepted_at ASC, id ASC`,
      )
      .all({ server_id: serverId, steam_id: steamId }) as PlayerQuestRow[];

    return this.#withProgress(rows);
  }

  /** Uma tentativa pelo id. É o que o push do plugin traz (`pq`). */
  attempt(playerQuestId: number): PlayerQuestRecord | null {
    const row = this.#db.prepare('SELECT * FROM player_quests WHERE id = @id').get({
      id: playerQuestId,
    }) as PlayerQuestRow | undefined;

    return row === undefined ? null : (this.#withProgress([row])[0] ?? null);
  }

  /**
   * A tentativa mais recente daquele jogador naquela quest, viva
   * ou não.
   *
   * É ela que responde ao cooldown ("quando ele resgatou?") e ao
   * `repeat_mode = 'once'` ("ele já fez?"). Quem interpreta a
   * resposta é o serviço.
   */
  lastAttempt(serverId: string, steamId: string, questId: string): PlayerQuestRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM player_quests
          WHERE server_id = @server_id AND steam_id = @steam_id AND quest_id = @quest_id
          ORDER BY attempt DESC
          LIMIT 1`,
      )
      .get({ server_id: serverId, steam_id: steamId, quest_id: questId }) as
      | PlayerQuestRow
      | undefined;

    return row === undefined ? null : (this.#withProgress([row])[0] ?? null);
  }

  /** Quantas tentativas vivas ele tem. É o número do teto (`maxActive`). */
  liveCountFor(serverId: string, steamId: string): number {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS total FROM player_quests
          WHERE server_id = @server_id AND steam_id = @steam_id
            AND status IN ('active','completed')`,
      )
      .get({ server_id: serverId, steam_id: steamId }) as { total: number };

    return row.total;
  }

  /**
   * Abre uma tentativa.
   *
   * ####  QUEM CHAMA JÁ DECIDIU QUE PODE  ####
   *
   * Cooldown, cadeia, teto, permissão e janela de evento são do
   * serviço. Daqui sai UMA recusa, e ela é de banco e não de
   * regra: já existe uma tentativa viva desta quest para este
   * jogador. Sem ela, aceitar duas vezes daria dois contadores
   * paralelos da mesma coisa, e o `assign` mandaria os dois ao
   * plugin.
   *
   * O `attempt` é calculado aqui porque é aritmética de banco: o
   * máximo que existe, mais um.
   */
  accept(
    input: {
      readonly serverId: string;
      readonly steamId: string;
      readonly playerName?: string | null;
      readonly questId: string;
      readonly snapshot: QuestSnapshot;
    },
    now: number = Date.now(),
  ): PlayerQuestRecord {
    const run = this.#db.transaction((): number => {
      const live = this.#db
        .prepare(
          `SELECT id FROM player_quests
            WHERE server_id = @server_id AND steam_id = @steam_id AND quest_id = @quest_id
              AND status IN ('active','completed')
            LIMIT 1`,
        )
        .get({
          server_id: input.serverId,
          steam_id: input.steamId,
          quest_id: input.questId,
        }) as { id: number } | undefined;

      if (live !== undefined) {
        throw new ApiError(
          'QUEST_ALREADY_ACTIVE',
          'Este jogador já está com esta quest em andamento.',
          409,
        );
      }

      this.#db.prepare(ENSURE_PLAYER).run({
        steam_id: input.steamId,
        name: input.playerName ?? '',
        at: now,
      });

      const previous = this.#db
        .prepare(
          `SELECT max(attempt) AS last FROM player_quests
            WHERE server_id = @server_id AND steam_id = @steam_id AND quest_id = @quest_id`,
        )
        .get({
          server_id: input.serverId,
          steam_id: input.steamId,
          quest_id: input.questId,
        }) as { last: number | null };

      const attempt = (previous.last ?? 0) + 1;

      const result = this.#db
        .prepare(
          `INSERT INTO player_quests
             (server_id, steam_id, quest_id, attempt, status, accepted_at, snapshot)
           VALUES
             (@server_id, @steam_id, @quest_id, @attempt, 'active', @accepted_at, @snapshot)`,
        )
        .run({
          server_id: input.serverId,
          steam_id: input.steamId,
          quest_id: input.questId,
          attempt,
          accepted_at: now,
          snapshot: JSON.stringify(input.snapshot),
        });

      // O contador de cada objetivo nasce em zero, e não vazio: a
      // tela do jogo mostra "0 / 5.000" desde o primeiro segundo, e
      // sem a linha ela teria de saber que ausência é zero.
      const bump = this.#db.prepare(BUMP_PROGRESS);
      const playerQuestId = Number(result.lastInsertRowid);

      for (const objective of input.snapshot.objectives) {
        bump.run({
          player_quest_id: playerQuestId,
          objective_seq: objective.seq,
          delta: 0,
          at: now,
        });
      }

      this.#insertEvent(
        {
          serverId: input.serverId,
          steamId: input.steamId,
          questId: input.questId,
          attempt,
          kind: 'accept',
          source: 'agent',
        },
        now,
      );

      return playerQuestId;
    });

    const id = run();
    const saved = this.attempt(id);

    if (saved === null) {
      throw new Error(`a tentativa ${String(id)} sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Aplica um lote de progresso, uma vez só.
   *
   * ####  A IDEMPOTÊNCIA NÃO É ZELO: É O DESENHO  ####
   *
   * O `ack` pode se perder DEPOIS do commit, e então o mesmo lote
   * volta na rodada seguinte. Sem o `quest_batches`, ele somaria
   * duas vezes e nada no log diria por quê — a mesma promessa que
   * o `stat_batches` guarda desde a migração 033.
   *
   * Entradas com delta zero são ignoradas: gravá-las carimbaria
   * `updated_at` sem ninguém ter feito nada.
   *
   * Entradas cuja tentativa NÃO ESTÁ MAIS VIVA também são
   * ignoradas, e isso é o caso normal: o jogador cancelou a quest
   * entre o lote ser congelado no plugin e chegar aqui. Somar
   * nelas ressuscitaria um contador que ninguém vai ver.
   */
  applyBatch(input: QuestBatchInput, now: number = Date.now()): ApplyQuestBatchResult {
    const run = this.#db.transaction((): ApplyQuestBatchResult => {
      const seen = this.#db
        .prepare('SELECT 1 FROM quest_batches WHERE server_id = @server_id AND batch_id = @batch_id')
        .get({ server_id: input.serverId, batch_id: input.batchId });

      if (seen !== undefined) {
        // Já aplicado. Quem chamou dá o `ack` de novo e segue: uma
        // confirmação repetida é barata, um lote em dobro não.
        return { applied: false, entriesApplied: 0, playersTouched: 0 };
      }

      const live = this.#db.prepare(
        `SELECT id FROM player_quests WHERE id = @id AND status = 'active'`,
      );
      const bump = this.#db.prepare(BUMP_PROGRESS);

      const touched = new Set<number>();
      let entriesApplied = 0;

      for (const entry of input.entries) {
        if (!Number.isFinite(entry.delta) || entry.delta <= 0) {
          continue;
        }

        if (live.get({ id: entry.playerQuestId }) === undefined) {
          continue;
        }

        bump.run({
          player_quest_id: entry.playerQuestId,
          objective_seq: entry.objectiveSeq,
          delta: Math.trunc(entry.delta),
          at: now,
        });

        touched.add(entry.playerQuestId);
        entriesApplied += 1;
      }

      this.#db
        .prepare(
          `INSERT INTO quest_batches (server_id, batch_id, applied_at, players, entries)
                VALUES (@server_id, @batch_id, @applied_at, @players, @entries)`,
        )
        .run({
          server_id: input.serverId,
          batch_id: input.batchId,
          applied_at: now,
          players: touched.size,
          entries: entriesApplied,
        });

      return { applied: true, entriesApplied, playersTouched: touched.size };
    });

    return run();
  }

  /**
   * Escreve um contador direto, sem somar.
   *
   * É a ferramenta de SUPORTE — o "ajustar contador" do painel — e
   * o caminho do `metric`/`playtime`, onde o agente calcula o
   * total (a diferença desde o aceite) em vez de receber deltas.
   *
   * Ela não registra evento: quem a chama sabe se aquilo é um
   * conserto de admin (que precisa de `actor` e motivo) ou o
   * recálculo de rotina de uma métrica.
   */
  setProgress(
    playerQuestId: number,
    objectiveSeq: number,
    value: number,
    now: number = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO player_quest_progress (player_quest_id, objective_seq, value, updated_at)
              VALUES (@player_quest_id, @objective_seq, @value, @at)
         ON CONFLICT (player_quest_id, objective_seq) DO UPDATE SET
              value = @value, updated_at = @at`,
      )
      .run({
        player_quest_id: playerQuestId,
        objective_seq: objectiveSeq,
        value: Math.max(0, Math.trunc(value)),
        at: now,
      });
  }

  /**
   * `active` → `completed`.
   *
   * ####  O `WHERE status = 'active'` É A TRAVA  ####
   *
   * O mesmo fato chega duas vezes de propósito — o push e o lote —,
   * e as duas chamam isto. A segunda encontra a tentativa já
   * `completed` e não muda nada: `false` aqui é o caso NORMAL, não
   * um erro.
   *
   * Sem a condição, `completed_at` seria reescrito com a hora da
   * segunda chegada, e o histórico diria que o jogador levou um
   * minuto a mais do que levou.
   */
  complete(playerQuestId: number, now: number = Date.now()): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE player_quests SET status = 'completed', completed_at = @at
            WHERE id = @id AND status = 'active'`,
        )
        .run({ id: playerQuestId, at: now }).changes > 0
    );
  }

  /**
   * `completed` → `claimed`.
   *
   * ####  MARCAR ANTES DE ENTREGAR  ####
   *
   * Quem chama grava isto, COMITA, e só então entrega. O inverso
   * — entregar e depois marcar — dá, numa queda no meio, um jogador
   * que recebeu duas vezes. Neste sentido, uma queda dá um jogador
   * que precisa de um clique do admin, e o painel mostra quem.
   *
   * É o oposto do que a loja faz, e a diferença é qual erro dói
   * mais: lá o jogador PAGOU, então não receber é roubo. Aqui ele
   * não pagou nada.
   *
   * `cooldownUntil` vem calculado do serviço, que é quem conhece o
   * `repeat_mode` e a hora da virada.
   */
  claim(
    playerQuestId: number,
    cooldownUntil: number | null,
    now: number = Date.now(),
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE player_quests SET status = 'claimed', claimed_at = @at, cooldown_until = @until
            WHERE id = @id AND status = 'completed'`,
        )
        .run({ id: playerQuestId, at: now, until: cooldownUntil }).changes > 0
    );
  }

  /**
   * Cancela.
   *
   * O progresso morre com a linha — a cascata de
   * `player_quest_progress` cuida —, e o histórico fica. Aceitar de
   * novo abre uma tentativa NOVA, do zero, que é o que quem clicou
   * em "cancelar" espera.
   *
   * ####  E ELE NÃO REGISTRA EVENTO, AO CONTRÁRIO DO `accept`  ####
   *
   * A assimetria é de propósito. Aceitar significa sempre a mesma
   * coisa; abandonar tem dois autores — o jogador que cancelou e o
   * admin que resetou —, e a frase do painel é diferente para cada
   * um. Quem chama sabe qual foi; este método não teria como
   * adivinhar, e um `abandon` genérico na auditoria esconderia
   * justamente o que ela existe para responder.
   */
  abandon(playerQuestId: number): boolean {
    const run = this.#db.transaction((): boolean => {
      const changed =
        this.#db
          .prepare(
            `UPDATE player_quests SET status = 'abandoned'
              WHERE id = @id AND status IN ('active','completed')`,
          )
          .run({ id: playerQuestId }).changes > 0;

      if (changed) {
        this.#db
          .prepare('DELETE FROM player_quest_progress WHERE player_quest_id = @id')
          .run({ id: playerQuestId });
      }

      return changed;
    });

    return run();
  }

  /**
   * O histórico de um jogador, do mais recente para o mais antigo.
   *
   * Paginado pelo SQL, e não em memória: um jogador de seis meses
   * tem centenas de tentativas, e ler todas para mostrar vinte
   * seria carregar o que ninguém vai ver.
   */
  historyOf(
    steamId: string,
    options: { readonly limit?: number; readonly offset?: number; readonly serverId?: string } = {},
  ): readonly PlayerQuestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM player_quests
          WHERE steam_id = @steam_id
            AND (@server_id IS NULL OR server_id = @server_id)
          ORDER BY accepted_at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({
        steam_id: steamId,
        server_id: options.serverId ?? null,
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
      }) as PlayerQuestRow[];

    return this.#withProgress(rows);
  }

  /** Quem está fazendo, ou já fez, uma quest. É a aba Progresso do painel. */
  playersOf(
    questId: string,
    options: {
      readonly status?: PlayerQuestStatus;
      readonly serverId?: string;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): readonly PlayerQuestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM player_quests
          WHERE quest_id = @quest_id
            AND (@status    IS NULL OR status    = @status)
            AND (@server_id IS NULL OR server_id = @server_id)
          ORDER BY accepted_at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({
        quest_id: questId,
        status: options.status ?? null,
        server_id: options.serverId ?? null,
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
      }) as PlayerQuestRow[];

    return this.#withProgress(rows);
  }

  // ======================================================
  //  A AUDITORIA
  // ======================================================

  /**
   * Registra o que aconteceu.
   *
   * ####  O MESMO `eventId` SÓ ENTRA UMA VEZ  ####
   *
   * O push e o lote trazem o mesmo fato de propósito, e o
   * `event_id` gerado pelo plugin é quem desempata. `false` aqui
   * quer dizer "já vi este", e é o caso NORMAL — nunca uma linha de
   * log de alarme.
   */
  recordEvent(input: QuestEventInput, now: number = Date.now()): boolean {
    return this.#insertEvent(input, now);
  }

  /** A auditoria, filtrável. Do mais recente para o mais antigo. */
  events(
    filter: {
      readonly steamId?: string;
      readonly questId?: string;
      readonly serverId?: string;
      readonly kind?: QuestEventKind;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): readonly QuestEventRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM quest_events
          WHERE (@steam_id  IS NULL OR steam_id  = @steam_id)
            AND (@quest_id  IS NULL OR quest_id  = @quest_id)
            AND (@server_id IS NULL OR server_id = @server_id)
            AND (@kind      IS NULL OR kind      = @kind)
          ORDER BY at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({
        steam_id: filter.steamId ?? null,
        quest_id: filter.questId ?? null,
        server_id: filter.serverId ?? null,
        kind: filter.kind ?? null,
        limit: filter.limit ?? 100,
        offset: filter.offset ?? 0,
      }) as EventRow[];

    return rows.map(toEventRecord);
  }

  // ======================================================
  //  O WIPE
  // ======================================================

  /**
   * Zera progresso.
   *
   * ####  O HISTÓRICO FICA  ####
   *
   * As tentativas vivas viram `abandoned` e o contador some; o que
   * já foi resgatado não é tocado, e `quest_events` não perde uma
   * linha. Apagar a auditoria reescreveria o passado — e o ranking
   * "quests concluídas" atravessa o wipe.
   *
   * ####  E O `wipe_policy` SÓ VALE NO WIPE  ####
   *
   * `respectPolicy` separa as duas chamadas: o wipe do mundo
   * respeita a escolha de cada quest (`keep` sobrevive); o botão do
   * painel zera o que foi pedido, porque quem clicou ali disse
   * exatamente o que queria.
   *
   * @throws quando nenhum recorte é dado — zerar o progresso de
   * todos os jogadores de todos os servidores por um corpo vazio é
   * o tipo de acidente que não se desfaz.
   */
  wipeProgress(
    input: QuestWipeInput & { readonly respectPolicy?: boolean },
    now: number = Date.now(),
  ): number {
    if (
      input.serverId === undefined &&
      input.questId === undefined &&
      input.steamId === undefined
    ) {
      throw new ApiError(
        'QUEST_WIPE_TOO_BROAD',
        'Diga o que zerar: um servidor, uma quest ou um jogador.',
        400,
      );
    }

    const where = `
      status IN ('active','completed')
        AND (@server_id IS NULL OR server_id = @server_id)
        AND (@quest_id  IS NULL OR quest_id  = @quest_id)
        AND (@steam_id  IS NULL OR steam_id  = @steam_id)
        AND (@respect = 0 OR quest_id IN (SELECT id FROM quests WHERE wipe_policy = 'reset'))
    `;

    const params = {
      server_id: input.serverId ?? null,
      quest_id: input.questId ?? null,
      steam_id: input.steamId ?? null,
      respect: input.respectPolicy === true ? 1 : 0,
    };

    const run = this.#db.transaction((): number => {
      // Os alvos são lidos ANTES do update: depois dele, o
      // `status IN ('active','completed')` não os encontraria mais,
      // e a auditoria ficaria sem saber de quem falar.
      const targets = this.#db
        .prepare(`SELECT * FROM player_quests WHERE ${where}`)
        .all(params) as PlayerQuestRow[];

      if (targets.length === 0) {
        return 0;
      }

      const ids = targets.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');

      this.#db
        .prepare(`UPDATE player_quests SET status = 'abandoned' WHERE id IN (${placeholders})`)
        .run(...ids);

      this.#db
        .prepare(
          `DELETE FROM player_quest_progress WHERE player_quest_id IN (${placeholders})`,
        )
        .run(...ids);

      for (const row of targets) {
        this.#insertEvent(
          {
            serverId: row.server_id,
            steamId: row.steam_id,
            questId: row.quest_id,
            attempt: row.attempt,
            kind: 'reset',
            source: input.respectPolicy === true ? 'wipe' : 'panel',
            actor: input.actor,
            detail: { reason: input.reason },
          },
          now,
        );
      }

      return targets.length;
    });

    return run();
  }

  // ======================================================
  //  A CONFIGURAÇÃO
  // ======================================================

  /** O que vale naquele servidor. Sem linha, os padrões do contrato. */
  settingsOf(serverId: string): QuestSettings {
    const row = this.#db
      .prepare('SELECT * FROM quest_settings WHERE server_id = @server_id')
      .get({ server_id: serverId }) as SettingsRow | undefined;

    if (row === undefined) {
      return DEFAULT_QUEST_SETTINGS;
    }

    return {
      maxActive: row.max_active,
      enabled: row.enabled === 1,
      flushSeconds: row.flush_seconds,
      lootEnabled: row.loot_enabled === 1,
      resetAtMinute: row.reset_at_minute,
      updatedAt: row.updated_at,
    };
  }

  saveSettings(
    serverId: string,
    input: QuestSettingsInput,
    now: number = Date.now(),
  ): QuestSettings {
    this.#db
      .prepare(
        `INSERT INTO quest_settings
           (server_id, max_active, enabled, flush_seconds, loot_enabled, reset_at_minute, updated_at)
         VALUES
           (@server_id, @max_active, @enabled, @flush_seconds, @loot_enabled, @reset_at_minute, @at)
         ON CONFLICT (server_id) DO UPDATE SET
           max_active      = @max_active,
           enabled         = @enabled,
           flush_seconds   = @flush_seconds,
           loot_enabled    = @loot_enabled,
           reset_at_minute = @reset_at_minute,
           updated_at      = @at`,
      )
      .run({
        server_id: serverId,
        max_active: input.maxActive,
        enabled: input.enabled ? 1 : 0,
        flush_seconds: input.flushSeconds,
        loot_enabled: input.lootEnabled ? 1 : 0,
        reset_at_minute: input.resetAtMinute,
        at: now,
      });

    return this.settingsOf(serverId);
  }

  // ======================================================
  //  OS NPCs  (migração 047)
  // ======================================================

  listNpcs(serverId?: string): readonly QuestNpcRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM quest_npcs
          WHERE (@server_id IS NULL OR server_id = @server_id)
          ORDER BY name COLLATE NOCASE ASC, id ASC`,
      )
      .all({ server_id: serverId ?? null }) as NpcRow[];

    return rows.map(toNpcRecord);
  }

  /**
   * Os que aquele servidor deve SPAWNAR.
   *
   * Só os ligados — um NPC desligado continua no banco, com a
   * posição guardada, e volta com um clique. Apagar para desligar
   * perderia a coordenada, que é a parte cara de recuperar.
   */
  listNpcsToSpawn(serverId: string): readonly QuestNpcRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM quest_npcs
          WHERE server_id = @server_id AND enabled = 1
          ORDER BY id ASC`,
      )
      .all({ server_id: serverId }) as NpcRow[];

    return rows.map(toNpcRecord);
  }

  getNpc(id: string): QuestNpcRecord | null {
    const row = this.#db.prepare('SELECT * FROM quest_npcs WHERE id = @id').get({ id }) as
      | NpcRow
      | undefined;

    return row === undefined ? null : toNpcRecord(row);
  }

  createNpc(id: string, input: QuestNpcInput, now: number = Date.now()): QuestNpcRecord {
    if (this.getNpc(id) !== null) {
      throw new ApiError('QUEST_NPC_ID_TAKEN', `Já existe um NPC com o id "${id}".`, 409);
    }

    this.#db
      .prepare(
        `INSERT INTO quest_npcs
           (id, server_id, name, kind, x, y, z, rotation, prefab, map_marker,
            use_radius, enabled, wipe_policy, created_at, updated_at)
         VALUES
           (@id, @server_id, @name, @kind, @x, @y, @z, @rotation, @prefab, @map_marker,
            @use_radius, @enabled, @wipe_policy, @created_at, @updated_at)`,
      )
      .run({ id, ...toNpcColumns(input), created_at: now, updated_at: now });

    const saved = this.getNpc(id);

    if (saved === null) {
      throw new Error(`o NPC "${id}" sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  updateNpc(id: string, input: QuestNpcInput, now: number = Date.now()): QuestNpcRecord | null {
    if (this.getNpc(id) === null) {
      return null;
    }

    this.#db
      .prepare(
        `UPDATE quest_npcs SET
           server_id   = @server_id,
           name        = @name,
           kind        = @kind,
           x           = @x,
           y           = @y,
           z           = @z,
           rotation    = @rotation,
           prefab      = @prefab,
           map_marker  = @map_marker,
           use_radius  = @use_radius,
           enabled     = @enabled,
           wipe_policy = @wipe_policy,
           updated_at  = @updated_at
         WHERE id = @id`,
      )
      .run({ id, ...toNpcColumns(input), updated_at: now });

    return this.getNpc(id);
  }

  /**
   * Apaga o NPC.
   *
   * ####  A QUEST DELE NÃO VAI JUNTO  ####
   *
   * `quests.npc_id` não tem FK (ver a migração 046), então nada
   * acontece por cascata — e é de propósito. Uma quest que perdeu o
   * NPC volta a ser uma quest de menu, com o progresso de quem
   * estava fazendo intacto. Quem avisa o admin é a rota, com o
   * `questsOfNpc`.
   */
  removeNpc(id: string): boolean {
    return this.#db.prepare('DELETE FROM quest_npcs WHERE id = @id').run({ id }).changes > 0;
  }

  /** As quests que apontam para aquele NPC. É o aviso antes de apagar. */
  questsOfNpc(npcId: string): readonly string[] {
    return (
      this.#db
        .prepare('SELECT id FROM quests WHERE npc_id = @npc_id ORDER BY id ASC')
        .all({ npc_id: npcId }) as { id: string }[]
    ).map((row) => row.id);
  }

  /**
   * O wipe do mundo leva os NPCs marcados como `remove`.
   *
   * @returns quantos sumiram.
   */
  wipeNpcs(serverId: string): number {
    return this.#db
      .prepare(
        `DELETE FROM quest_npcs WHERE server_id = @server_id AND wipe_policy = 'remove'`,
      )
      .run({ server_id: serverId }).changes;
  }

  // ======================================================
  //  Privados
  // ======================================================

  /**
   * Junta as quests às três tabelas filhas, em três consultas.
   *
   * Ver o comentário do `list`: por quest seria o N+1 da tela que
   * lista tudo.
   */
  #hydrate(rows: readonly QuestRow[]): readonly QuestRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const objectives = new Map<string, QuestObjective[]>();
    const rewards = new Map<string, QuestReward[]>();
    const servers = new Map<string, string[]>();

    for (const row of this.#db
      .prepare('SELECT * FROM quest_objectives ORDER BY quest_id, seq')
      .all() as ObjectiveRow[]) {
      push(objectives, row.quest_id, toObjective(row));
    }

    for (const row of this.#db
      .prepare('SELECT * FROM quest_rewards ORDER BY quest_id, seq')
      .all() as RewardRow[]) {
      const reward = toReward(row);

      if (reward !== null) {
        push(rewards, row.quest_id, reward);
      }
    }

    for (const row of this.#db
      .prepare('SELECT quest_id, server_id FROM quest_servers ORDER BY quest_id, server_id')
      .all() as { quest_id: string; server_id: string }[]) {
      push(servers, row.quest_id, row.server_id);
    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      enabled: row.enabled === 1,
      sort: row.sort,
      requires: row.requires,
      npcId: row.npc_id,
      repeatMode: row.repeat_mode as QuestRepeatMode,
      cooldownSeconds: row.cooldown_seconds,
      requiresQuest: row.requires_quest,
      availableFrom: row.available_from,
      availableTo: row.available_to,
      autoAccept: row.auto_accept === 1,
      wipePolicy: row.wipe_policy as QuestWipePolicy,
      servers: servers.get(row.id) ?? [],
      objectives: objectives.get(row.id) ?? [],
      rewards: rewards.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  #withProgress(rows: readonly PlayerQuestRow[]): readonly PlayerQuestRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');

    const byAttempt = new Map<number, Record<number, number>>();

    for (const row of this.#db
      .prepare(
        `SELECT player_quest_id, objective_seq, value
           FROM player_quest_progress
          WHERE player_quest_id IN (${placeholders})`,
      )
      .all(...ids) as {
      player_quest_id: number;
      objective_seq: number;
      value: number;
    }[]) {
      const current = byAttempt.get(row.player_quest_id) ?? {};

      current[row.objective_seq] = row.value;
      byAttempt.set(row.player_quest_id, current);
    }

    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      steamId: row.steam_id,
      questId: row.quest_id,
      attempt: row.attempt,
      status: row.status as PlayerQuestStatus,
      acceptedAt: row.accepted_at,
      completedAt: row.completed_at,
      claimedAt: row.claimed_at,
      cooldownUntil: row.cooldown_until,
      snapshot: parseSnapshot(row.snapshot),
      progress: byAttempt.get(row.id) ?? {},
    }));
  }

  #replaceChildren(questId: string, input: QuestInput): void {
    this.#db.prepare('DELETE FROM quest_objectives WHERE quest_id = @id').run({ id: questId });
    this.#db.prepare('DELETE FROM quest_rewards WHERE quest_id = @id').run({ id: questId });
    this.#db.prepare('DELETE FROM quest_servers WHERE quest_id = @id').run({ id: questId });

    const objective = this.#db.prepare(
      `INSERT INTO quest_objectives (quest_id, seq, kind, target, metric, amount, label, consume)
            VALUES (@quest_id, @seq, @kind, @target, @metric, @amount, @label, @consume)`,
    );

    for (const item of input.objectives) {
      objective.run({
        quest_id: questId,
        seq: item.seq,
        kind: item.kind,
        target: item.target,
        metric: item.metric,
        amount: item.amount,
        label: item.label,
        consume: item.consume ? 1 : 0,
      });
    }

    const reward = this.#db.prepare(
      `INSERT INTO quest_rewards (quest_id, seq, kind, payload)
            VALUES (@quest_id, @seq, @kind, @payload)`,
    );

    input.rewards.forEach((item, index) => {
      const { kind, ...payload } = item;

      reward.run({ quest_id: questId, seq: index, kind, payload: JSON.stringify(payload) });
    });

    const server = this.#db.prepare(
      'INSERT OR IGNORE INTO quest_servers (quest_id, server_id) VALUES (@quest_id, @server_id)',
    );

    // O `Set` porque a tela pode mandar o mesmo servidor duas vezes
    // e o `INSERT OR IGNORE` engoliria em silêncio — melhor não
    // chegar lá.
    for (const serverId of new Set(input.servers)) {
      server.run({ quest_id: questId, server_id: serverId });
    }
  }

  #insertEvent(input: QuestEventInput, now: number): boolean {
    return (
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO quest_events
             (event_id, server_id, steam_id, quest_id, attempt, kind, detail, source, actor, at)
           VALUES
             (@event_id, @server_id, @steam_id, @quest_id, @attempt, @kind, @detail, @source,
              @actor, @at)`,
        )
        .run({
          event_id: input.eventId ?? null,
          server_id: input.serverId,
          steam_id: input.steamId,
          quest_id: input.questId,
          attempt: input.attempt,
          kind: input.kind,
          detail: input.detail === undefined ? null : JSON.stringify(input.detail),
          source: input.source,
          actor: input.actor ?? null,
          at: now,
        }).changes > 0
    );
  }
}

// ------------------------------------------------------------
//  §5  TRADUÇÃO
// ------------------------------------------------------------

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);

  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

function toQuestColumns(input: QuestInput): Record<string, unknown> {
  return {
    title: input.title,
    description: input.description,
    category: input.category,
    enabled: input.enabled ? 1 : 0,
    sort: input.sort,
    requires: input.requires,
    npc_id: input.npcId,
    repeat_mode: input.repeatMode,
    cooldown_seconds: input.cooldownSeconds,
    requires_quest: input.requiresQuest,
    available_from: input.availableFrom,
    available_to: input.availableTo,
    auto_accept: input.autoAccept ? 1 : 0,
    wipe_policy: input.wipePolicy,
  };
}

function toObjective(row: ObjectiveRow): QuestObjective {
  return {
    seq: row.seq,
    kind: row.kind as QuestObjectiveKind,
    target: row.target,
    metric: row.metric,
    amount: row.amount,
    label: row.label,
    consume: row.consume === 1,
  };
}

/**
 * O JSON da coluna vira recompensa.
 *
 * ####  UMA RECOMPENSA ILEGÍVEL SOME; A QUEST FICA  ####
 *
 * `null` quando o JSON quebrou — e quem chama a descarta. A coluna
 * é escrita por nós, então um valor ilegível ali é defeito nosso; e
 * derrubar a listagem inteira por causa de uma recompensa
 * esconderia as outras trinta quests que estão boas. É a mesma
 * escolha do `parseAction` do item custom.
 *
 * O tipo não é validado aqui de propósito: o zod é a régua da
 * ENTRADA, e revalidar na leitura faria o painel mostrar menos do
 * que o banco tem sempre que a régua ficasse mais estrita. Quem
 * entrega confere o que precisa.
 */
function toReward(row: RewardRow): QuestReward | null {
  try {
    const parsed: unknown = JSON.parse(row.payload);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return { ...(parsed as object), kind: row.kind as QuestRewardKind } as QuestReward;
  } catch {
    return null;
  }
}

/**
 * O snapshot congelado vira objeto.
 *
 * ####  AQUI O SILÊNCIO NÃO SERVE  ####
 *
 * Ao contrário da recompensa avulsa, um snapshot ilegível torna a
 * tentativa inteira impossível de julgar: não há como dizer o que
 * ela exigia nem o que prometia. Devolver um snapshot VAZIO é
 * honesto — a tentativa aparece no painel sem objetivo nenhum, o
 * que é visivelmente errado — e não derruba a listagem dos outros
 * jogadores.
 */
function parseSnapshot(raw: string): QuestSnapshot {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === 'object' && parsed !== null && 'objectives' in parsed) {
      return parsed as QuestSnapshot;
    }
  } catch {
    // Ver o comentário acima.
  }

  return { title: '', objectives: [], rewards: [] };
}

function toNpcColumns(input: QuestNpcInput): Record<string, unknown> {
  return {
    server_id: input.serverId,
    name: input.name,
    kind: input.kind,
    x: input.x,
    y: input.y,
    z: input.z,
    rotation: input.rotation,
    prefab: input.prefab,
    map_marker: input.mapMarker ? 1 : 0,
    use_radius: input.useRadius,
    enabled: input.enabled ? 1 : 0,
    wipe_policy: input.wipePolicy,
  };
}

function toNpcRecord(row: NpcRow): QuestNpcRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    kind: row.kind as QuestNpcKind,
    x: row.x,
    y: row.y,
    z: row.z,
    rotation: row.rotation,
    prefab: row.prefab,
    mapMarker: row.map_marker === 1,
    useRadius: row.use_radius,
    enabled: row.enabled === 1,
    wipePolicy: row.wipe_policy as QuestNpcWipePolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEventRecord(row: EventRow): QuestEventRecord {
  let detail: unknown = null;

  if (row.detail !== null) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      // Auditoria não derruba leitura: o resto da linha continua
      // dizendo quem, quando e o quê.
      detail = null;
    }
  }

  return {
    id: row.id,
    eventId: row.event_id,
    serverId: row.server_id,
    steamId: row.steam_id,
    questId: row.quest_id,
    attempt: row.attempt,
    kind: row.kind as QuestEventKind,
    detail,
    source: row.source as QuestEventSource,
    actor: row.actor,
    at: row.at,
  };
}
