// ============================================================
//  wipe-runs-repository.ts  -  as execuções de wipe, no banco.
//
//  ####  POR QUE ISTO NÃO É SÓ UMA `Operation`  ####
//
//  Todo trabalho longo do agente é uma `Operation` (ops/operations.ts),
//  e ela mora em memória: vinte no histórico, e todas somem no
//  `pm2 restart`. Para instalar 6 GB isso basta. Para um wipe não,
//  por duas perguntas que só o banco responde:
//
//    "o que aconteceu no wipe do dia 6?"     — semanas depois
//    "retomar de que passo?"                 — depois de um restart
//
//  A segunda é a que muda o desenho. Sem os passos gravados, a
//  única saída de uma execução interrompida seria rodar tudo de
//  novo — e no meio de um wipe "de novo" significa apagar um mundo
//  que já é o NOVO.
//
//  ------------------------------------------------------------
//  ####  E ESTE ARQUIVO GUARDA TAMBÉM A CONFIGURAÇÃO DA EXECUÇÃO  ####
//
//  Os avisos, o esvaziamento, o backup e a lista do full wipe
//  moram em `wipe_settings` — a MESMA tabela chave/valor da agenda
//  (migração 023), com o prefixo desta frente. Não é migração
//  nova porque não precisa ser: a tabela nasceu chave/valor
//  justamente para uma chave nova não custar uma.
//
//  A leitura é TOLERANTE, como a da agenda: valor inválido numa
//  chave cai no padrão DAQUELA chave, e as outras continuam
//  valendo. Lançar aqui faria um número digitado errado direto no
//  SQLite derrubar o boot do agente inteiro.
// ============================================================

import type { AgentDatabase } from './database.js';
import {
  WIPE_RUN_STATUSES,
  WIPE_RUN_STEPS,
  WIPE_STEP_STATUSES,
  type BpPolicy,
  type WipePlanKind,
  type WipeRunStatus,
  type WipeRunStep,
  type WipeStepStatus,
} from '../types/wipe.js';

// ------------------------------------------------------------
//  §1  A CONFIGURAÇÃO DA EXECUÇÃO
// ------------------------------------------------------------

/** Quando o servidor avisa, e com que cara. */
export interface WipeAnnounceSettings {
  /** Quantos minutos ANTES cada aviso sai. Do maior para o menor. */
  readonly offsetsMinutes: readonly number[];
  /** O template do admin. `{wipe.faltam}` é resolvido no envio. */
  readonly text: string;
  readonly tag: string;
  readonly tagColor: string;
  readonly color: string;
  readonly size: number;
}

/** Como o agente tira os jogadores antes de parar. */
export interface WipeDrainSettings {
  readonly enabled: boolean;
  /** O teto da espera. Esperar para sempre não é esvaziar. */
  readonly waitMinutes: number;
  /**
   * Matar o processo quando o RCON não responde.
   *
   * Desligado por padrão: `quit` pelo RCON salva antes de sair, e
   * matar perde tudo desde o último save automático.
   */
  readonly force: boolean;
}

export interface WipeBackupSettings {
  readonly enabled: boolean;
  /** Quantos zips ficam em `Backups\<id>\`. */
  readonly keep: number;
}

/** O full wipe: nada vem marcado, e a lista é de PADRÕES. */
export interface WipePluginDataSettings {
  readonly enabled: boolean;
  readonly patterns: readonly string[];
}

/** O que o agente faz depois de o servidor voltar. */
export interface WipePostSettings {
  readonly resync: boolean;
  readonly announce: boolean;
  readonly announceText: string;
}

/** Tudo o que o admin decide sobre COMO o wipe é executado. */
export interface WipeExecSettings {
  readonly announce: WipeAnnounceSettings;
  readonly drain: WipeDrainSettings;
  readonly backup: WipeBackupSettings;
  readonly pluginData: WipePluginDataSettings;
  readonly post: WipePostSettings;
}

/**
 * Os padrões.
 *
 * ####  A LISTA DO FULL WIPE NASCE VAZIA  ####
 *
 * Não é esquecimento: é a regra 6 da frente. O `OrigemZVip.json` é
 * o VIP que alguém pagou, e nenhum padrão nosso pode marcá-lo
 * sozinho. Ver wipe/plugin-data.ts.
 */
export const DEFAULT_WIPE_EXEC_SETTINGS: WipeExecSettings = {
  announce: {
    // Do maior para o menor, e é a ordem em que eles saem.
    offsetsMinutes: [1440, 360, 60, 15, 5, 1],
    text: 'WIPE em {wipe.faltam}. Guardem o que puderem — o mundo vai ser zerado.',
    tag: 'WIPE',
    tagColor: '#ff4444',
    color: '#ffffff',
    size: 15,
  },
  drain: { enabled: true, waitMinutes: 5, force: false },
  backup: { enabled: true, keep: 3 },
  pluginData: { enabled: false, patterns: [] },
  post: {
    resync: true,
    announce: true,
    announceText: 'Mundo novo no ar! Boa sorte a todos.',
  },
};

const KEY = {
  announceOffsets: 'announce.offsets',
  announceText: 'announce.text',
  announceTag: 'announce.tag',
  announceTagColor: 'announce.tagColor',
  announceColor: 'announce.color',
  announceSize: 'announce.size',
  drainEnabled: 'drain.enabled',
  drainWaitMinutes: 'drain.waitMinutes',
  drainForce: 'drain.force',
  backupEnabled: 'backup.enabled',
  backupKeep: 'backup.keep',
  pluginDataEnabled: 'pluginData.enabled',
  pluginDataPatterns: 'pluginData.patterns',
  postResync: 'post.resync',
  postAnnounce: 'post.announce',
  postAnnounceText: 'post.announceText',
} as const;

/** O maior aviso que faz sentido: dois dias. */
export const MAX_ANNOUNCE_OFFSET_MINUTES = 2880;

/** Quantos avisos cabem numa execução, para a lista não virar spam. */
export const MAX_ANNOUNCE_OFFSETS = 12;

// ------------------------------------------------------------
//  §2  AS LINHAS
// ------------------------------------------------------------

/** Uma execução de wipe, do jeito que a tela e a máquina de passos leem. */
export interface WipeRunRecord {
  readonly id: number;
  readonly serverId: string;
  readonly planId: number | null;
  readonly operationId: string | null;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly fullWipe: boolean;
  readonly startedAt: number;
  /** Quando o MUNDO zera. Depois de `startedAt` quando há avisos. */
  readonly wipeAt: number;
  readonly finishedAt: number | null;
  readonly status: WipeRunStatus;
  readonly backupPath: string | null;
  readonly mapBefore: WipeWorld | null;
  readonly mapAfter: WipeWorld | null;
  /**
   * O mundo que `configurar` ESCOLHEU, gravado antes do `.ini`.
   *
   * `null` = o passo ainda não decidiu. Ver `WipeMapDecision`.
   */
  readonly mapDecision: WipeMapDecision | null;
  readonly saveCreatedBefore: number | null;
  readonly saveCreatedAfter: number | null;
  readonly message: string | null;
  readonly steps: readonly WipeRunStepRecord[];
}

/** O mundo de antes ou o de depois, como ele é gravado no JSON. */
export interface WipeWorld {
  readonly level: string | null;
  readonly seed: string | null;
  readonly worldSize: number | null;
  readonly levelUrl?: string | null;
  /** A entrada da fila que virou este mundo, quando houve uma. */
  readonly mapPoolId?: number | null;
  /** O agente sorteou a seed porque a fila estava vazia. */
  readonly drawn?: boolean;
}

/**
 * A decisão de mundo que o passo `configurar` TOMOU, congelada.
 *
 * ####  ESCOLHER NÃO É RECALCULAR  ####
 *
 * A decisão (`mapOfPlan`, em wipe/next-wipe.ts) lê o mundo de
 * AGORA para uma pergunta: um wipe FORÇADO não MANTÉM um `.map`
 * custom sem a marca de compatibilidade. E o próprio passo
 * reescreve esse mundo — ele grava `levelurl` vazia no `.ini`
 * antes de gravar o resultado no banco. Entre as duas escritas o
 * agente pode morrer, e a retomada relia um `.ini` já procedural:
 * a trava não pegava mais, o `keep` voltava a valer e o passo
 * "mantinha" um mundo que tinha acabado de sair da FILA — com a
 * entrada ainda `ready`, o `map_after` sem `map_pool_id` e a régua
 * do VIP anunciando como "o próximo mundo" o que já estava no ar.
 *
 * Por isso a decisão é gravada ANTES do `.ini`, aqui, e a retomada
 * a RELÊ em vez de refazê-la. Ela não consome nada: queimar a fila
 * continua sendo o `commitWorld`, depois do `.ini`. Gravar a
 * escolha e consumi-la são dois tempos, como já eram para a
 * curadoria e para o sorteio.
 *
 * A entrada viaja por ID, e não por cópia: o nome, a seed e a nota
 * dela continuam morando na fila, e uma cópia aqui seria uma
 * segunda verdade sobre a mesma linha.
 */
export type WipeMapDecision =
  /** O mundo de agora fica: `mapSource: 'keep'`, e nada o recusou. */
  | { readonly source: 'keep' }
  /** A entrada da fila que este wipe vai consumir. */
  | { readonly source: 'entry'; readonly mapPoolId: number }
  /** Nada na fila serve: o agente sorteia na hora de gravar o `.ini`. */
  | { readonly source: 'undecided' };

export interface WipeRunStepRecord {
  readonly step: WipeRunStep;
  readonly position: number;
  readonly status: WipeStepStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly message: string | null;
}

export interface WipeRunInput {
  readonly planId?: number | null;
  readonly operationId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly fullWipe?: boolean;
  /** Quando o mundo zera. Ausente = agora, e o passo `avisar` não espera. */
  readonly wipeAt?: number;
  readonly mapBefore?: WipeWorld | null;
  readonly saveCreatedBefore?: number | null;
}

export interface WipeRunPatch {
  readonly operationId?: string | null | undefined;
  readonly status?: WipeRunStatus | undefined;
  readonly finishedAt?: number | null | undefined;
  readonly backupPath?: string | null | undefined;
  readonly mapAfter?: WipeWorld | null | undefined;
  /** A decisão congelada. Quem a grava é o passo `configurar`. */
  readonly mapDecision?: WipeMapDecision | null | undefined;
  readonly saveCreatedAfter?: number | null | undefined;
  readonly message?: string | null | undefined;
}

interface RunRow {
  readonly id: number;
  readonly server_id: string;
  readonly plan_id: number | null;
  readonly operation_id: string | null;
  readonly kind: string;
  readonly bp_policy: string;
  readonly full_wipe: number;
  readonly started_at: number;
  readonly wipe_at: number;
  readonly finished_at: number | null;
  readonly status: string;
  readonly backup_path: string | null;
  readonly map_before: string | null;
  readonly map_after: string | null;
  readonly map_decision: string | null;
  readonly save_created_before: number | null;
  readonly save_created_after: number | null;
  readonly message: string | null;
}

interface StepRow {
  readonly run_id: number;
  readonly step: string;
  readonly position: number;
  readonly status: string;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly message: string | null;
}

const RUN_COLUMNS = `id, server_id, plan_id, operation_id, kind, bp_policy, full_wipe,
  started_at, wipe_at, finished_at, status, backup_path, map_before, map_after,
  map_decision, save_created_before, save_created_after, message`;

/**
 * ####  CADA SERVIDOR TEM AS SUAS EXECUÇÕES  ####
 *
 * `serverId` é o primeiro argumento de tudo aqui, como no resto do
 * banco desta árvore. Uma consulta por `id` sozinho devolveria a
 * execução de outro servidor a quem pedisse o número errado — e a
 * rota que a chama já tem o id na URL.
 */
export class WipeRunsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ----------------------------------------------------------
  //  A configuração da execução
  // ----------------------------------------------------------

  getExecSettings(serverId: string): WipeExecSettings {
    const rows = this.#db
      .prepare('SELECT key, value FROM wipe_settings WHERE server_id = @server_id')
      .all({ server_id: serverId }) as { readonly key: string; readonly value: string }[];

    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const base = DEFAULT_WIPE_EXEC_SETTINGS;

    const text = (key: string, fallback: string): string => {
      const raw = stored.get(key);

      return raw === undefined || raw.trim() === '' ? fallback : raw;
    };

    const flag = (key: string, fallback: boolean): boolean => {
      const raw = stored.get(key);

      return raw === undefined ? fallback : raw === '1' || raw.toLowerCase() === 'true';
    };

    const integer = (key: string, fallback: number, min: number, max: number): number => {
      const raw = stored.get(key);
      const parsed = raw === undefined ? Number.NaN : Number(raw);

      if (!Number.isFinite(parsed)) {
        return fallback;
      }

      return Math.max(min, Math.min(max, Math.round(parsed)));
    };

    return {
      announce: {
        offsetsMinutes: parseOffsets(stored.get(KEY.announceOffsets), base.announce.offsetsMinutes),
        text: text(KEY.announceText, base.announce.text),
        tag: text(KEY.announceTag, base.announce.tag),
        tagColor: text(KEY.announceTagColor, base.announce.tagColor),
        color: text(KEY.announceColor, base.announce.color),
        size: integer(KEY.announceSize, base.announce.size, 8, 40),
      },
      drain: {
        enabled: flag(KEY.drainEnabled, base.drain.enabled),
        waitMinutes: integer(KEY.drainWaitMinutes, base.drain.waitMinutes, 0, 60),
        force: flag(KEY.drainForce, base.drain.force),
      },
      backup: {
        enabled: flag(KEY.backupEnabled, base.backup.enabled),
        keep: integer(KEY.backupKeep, base.backup.keep, 1, 30),
      },
      pluginData: {
        enabled: flag(KEY.pluginDataEnabled, base.pluginData.enabled),
        patterns: parsePatterns(stored.get(KEY.pluginDataPatterns)),
      },
      post: {
        resync: flag(KEY.postResync, base.post.resync),
        announce: flag(KEY.postAnnounce, base.post.announce),
        announceText: text(KEY.postAnnounceText, base.post.announceText),
      },
    };
  }

  saveExecSettings(
    serverId: string,
    settings: WipeExecSettings,
    now: number = Date.now(),
  ): WipeExecSettings {
    const statement = this.#db.prepare(
      `INSERT INTO wipe_settings (server_id, key, value, updated_at)
            VALUES (@server_id, @key, @value, @now)
       ON CONFLICT (server_id, key) DO UPDATE SET value = @value, updated_at = @now`,
    );

    const values: Readonly<Record<string, string>> = {
      [KEY.announceOffsets]: settings.announce.offsetsMinutes.join(','),
      [KEY.announceText]: settings.announce.text,
      [KEY.announceTag]: settings.announce.tag,
      [KEY.announceTagColor]: settings.announce.tagColor,
      [KEY.announceColor]: settings.announce.color,
      [KEY.announceSize]: String(settings.announce.size),
      [KEY.drainEnabled]: settings.drain.enabled ? '1' : '0',
      [KEY.drainWaitMinutes]: String(settings.drain.waitMinutes),
      [KEY.drainForce]: settings.drain.force ? '1' : '0',
      [KEY.backupEnabled]: settings.backup.enabled ? '1' : '0',
      [KEY.backupKeep]: String(settings.backup.keep),
      [KEY.pluginDataEnabled]: settings.pluginData.enabled ? '1' : '0',
      // JSON, e não uma lista separada por vírgula: um caminho de
      // arquivo pode ter vírgula, e o dia em que tiver seria um
      // full wipe apagando dois arquivos que ninguém marcou.
      [KEY.pluginDataPatterns]: JSON.stringify(settings.pluginData.patterns),
      [KEY.postResync]: settings.post.resync ? '1' : '0',
      [KEY.postAnnounce]: settings.post.announce ? '1' : '0',
      [KEY.postAnnounceText]: settings.post.announceText,
    };

    this.#db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        statement.run({ server_id: serverId, key, value, now });
      }
    })();

    return this.getExecSettings(serverId);
  }

  // ----------------------------------------------------------
  //  As execuções
  // ----------------------------------------------------------

  /**
   * Abre uma execução com os oito passos já `pending`.
   *
   * Os passos nascem TODOS de uma vez, e não conforme acontecem:
   * é o que permite a tela desenhar a lista inteira desde o
   * primeiro segundo, com os que ainda não vieram em cinza. Uma
   * lista que cresce enquanto roda esconde justamente o que falta.
   */
  create(serverId: string, input: WipeRunInput, now: number = Date.now()): WipeRunRecord {
    const id = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `INSERT INTO wipe_runs (server_id, plan_id, operation_id, idempotency_key, kind,
                                  bp_policy, full_wipe, started_at, wipe_at, status,
                                  map_before, save_created_before, created_at, updated_at)
                VALUES (@server_id, @plan_id, @operation_id, @idempotency_key, @kind,
                        @bp_policy, @full_wipe, @now, @wipe_at, 'running', @map_before,
                        @save_created_before, @now, @now)`,
        )
        .run({
          server_id: serverId,
          plan_id: input.planId ?? null,
          operation_id: input.operationId ?? null,
          idempotency_key: input.idempotencyKey ?? null,
          kind: input.kind,
          bp_policy: input.bpPolicy,
          full_wipe: input.fullWipe === true ? 1 : 0,
          now,
          wipe_at: input.wipeAt ?? now,
          map_before: input.mapBefore === undefined ? null : JSON.stringify(input.mapBefore),
          save_created_before: input.saveCreatedBefore ?? null,
        });

      const runId = Number(result.lastInsertRowid);
      const step = this.#db.prepare(
        `INSERT INTO wipe_run_steps (run_id, step, position, status)
              VALUES (@run_id, @step, @position, 'pending')`,
      );

      WIPE_RUN_STEPS.forEach((name, position) => {
        step.run({ run_id: runId, step: name, position });
      });

      return runId;
    })();

    return this.#require(serverId, id);
  }

  get(serverId: string, id: number): WipeRunRecord | null {
    const row = this.#db
      .prepare(`SELECT ${RUN_COLUMNS} FROM wipe_runs WHERE server_id = @server_id AND id = @id`)
      .get({ server_id: serverId, id }) as RunRow | undefined;

    return row === undefined ? null : this.#toRecord(row);
  }

  /** A execução já aberta com aquela chave, ou `null`. Ver a regra 7. */
  byIdempotencyKey(serverId: string, key: string): WipeRunRecord | null {
    const row = this.#db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM wipe_runs
          WHERE server_id = @server_id AND idempotency_key = @key`,
      )
      .get({ server_id: serverId, key }) as RunRow | undefined;

    return row === undefined ? null : this.#toRecord(row);
  }

  /** Da mais nova para a mais velha. */
  list(serverId: string, limit = 20): readonly WipeRunRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM wipe_runs
          WHERE server_id = @server_id
          ORDER BY started_at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ server_id: serverId, limit }) as RunRow[];

    return rows.map((row) => this.#toRecord(row));
  }

  /** As que ficaram `running` — em QUALQUER servidor. Ver `orphan`. */
  running(): readonly WipeRunRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${RUN_COLUMNS} FROM wipe_runs WHERE status = 'running'`)
      .all() as RunRow[];

    return rows.map((row) => this.#toRecord(row));
  }

  update(
    serverId: string,
    id: number,
    patch: WipeRunPatch,
    now: number = Date.now(),
  ): WipeRunRecord {
    const sets: string[] = ['updated_at = @now'];
    const params: Record<string, unknown> = { server_id: serverId, id, now };

    if (patch.operationId !== undefined) {
      sets.push('operation_id = @operation_id');
      params.operation_id = patch.operationId;
    }

    if (patch.status !== undefined) {
      sets.push('status = @status');
      params.status = patch.status;
    }

    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = @finished_at');
      params.finished_at = patch.finishedAt;
    }

    if (patch.backupPath !== undefined) {
      sets.push('backup_path = @backup_path');
      params.backup_path = patch.backupPath;
    }

    if (patch.mapAfter !== undefined) {
      sets.push('map_after = @map_after');
      params.map_after = patch.mapAfter === null ? null : JSON.stringify(patch.mapAfter);
    }

    if (patch.mapDecision !== undefined) {
      sets.push('map_decision = @map_decision');
      params.map_decision = patch.mapDecision === null ? null : JSON.stringify(patch.mapDecision);
    }

    if (patch.saveCreatedAfter !== undefined) {
      sets.push('save_created_after = @save_created_after');
      params.save_created_after = patch.saveCreatedAfter;
    }

    if (patch.message !== undefined) {
      sets.push('message = @message');
      params.message = patch.message;
    }

    this.#db
      .prepare(`UPDATE wipe_runs SET ${sets.join(', ')} WHERE server_id = @server_id AND id = @id`)
      .run(params);

    return this.#require(serverId, id);
  }

  /**
   * O mundo do wipe e a queima da fila: as duas, ou nenhuma.
   *
   * ####  DUAS ESCRITAS ADJACENTES QUE PRECISAM SER UMA  ####
   *
   * O passo `configurar` grava o mundo em `map_after` — a marca de
   * idempotência que a retomada lê — e queima a entrada que virou
   * esse mundo. Entre uma e outra o agente podia cair, e o custo
   * não era só um mapa repetido: a entrada continuava `ready`,
   * sem registro nenhum de que já subiu, a retomada pulava o passo
   * inteiro (o `map_after` já estava lá) e o wipe SEGUINTE
   * consumia a MESMA entrada — a mesma seed dois wipes em fila. No
   * intervalo, a régua do VIP anunciava como "o próximo mundo" o
   * mundo que já estava no ar.
   *
   * ####  POR QUE UM CALLBACK, E NÃO O MUNDO PRONTO  ####
   *
   * Porque a entrada SORTEADA nasce aqui dentro: o id dela só
   * existe depois do INSERT, e é ele que vai no `map_after`. O
   * `escolher` roda dentro da transação, devolve o mundo já
   * completo, e as escritas dele — que são da fila, e por isso
   * continuam saindo do `MapPoolRepository` — sobem ou descem
   * junto com esta. Ele é SÍNCRONO de propósito: uma transação do
   * better-sqlite3 não sobrevive a um `await` no meio.
   */
  commitWorld(
    serverId: string,
    id: number,
    escolher: () => WipeWorld,
    now: number = Date.now(),
  ): WipeRunRecord {
    return this.#db.transaction((): WipeRunRecord => {
      const world = escolher();

      return this.update(serverId, id, { mapAfter: world }, now);
    })();
  }

  /**
   * Marca UM passo.
   *
   * Só grava `started_at` na primeira vez que o passo vira
   * `running`: numa RETOMADA, o passo roda de novo e o começo
   * original é o que responde "a que horas este wipe começou de
   * verdade".
   */
  markStep(
    runId: number,
    step: WipeRunStep,
    status: WipeStepStatus,
    message: string | null = null,
    now: number = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE wipe_run_steps
            SET status = @status,
                started_at = CASE
                  WHEN @status = 'running' AND started_at IS NULL THEN @now
                  ELSE started_at END,
                finished_at = CASE
                  WHEN @status IN ('done', 'failed', 'skipped') THEN @now
                  ELSE NULL END,
                message = COALESCE(@message, message)
          WHERE run_id = @run_id AND step = @step`,
      )
      .run({ run_id: runId, step, status, message, now });
  }

  /**
   * A execução interrompida vira `failed`, e a tela oferece retomar.
   *
   * ####  DEIXÁ-LA `running` PARA SEMPRE É A ÚNICA SAÍDA PIOR  ####
   *
   * Uma linha `running` eterna bloqueia o próximo wipe (a trava
   * por recurso), não aparece no histórico como problema e não
   * oferece retomada. Falhar é a resposta honesta: o agente
   * reiniciou no meio, e alguém precisa decidir o que fazer.
   */
  orphan(serverId: string, id: number, now: number = Date.now()): WipeRunRecord {
    this.#db
      .prepare(
        `UPDATE wipe_run_steps SET status = 'failed', finished_at = @now,
                message = COALESCE(message, 'o agente reiniciou com este passo em andamento')
          WHERE run_id = @id AND status = 'running'`,
      )
      .run({ id, now });

    return this.update(
      serverId,
      id,
      {
        status: 'failed',
        finishedAt: now,
        operationId: null,
        message:
          'O agente reiniciou no meio desta execução. Confira em que passo ela parou e retome — ' +
          'todo passo é idempotente, e o que já foi feito não é refeito.',
      },
      now,
    );
  }

  // ----------------------------------------------------------
  //  Interno
  // ----------------------------------------------------------

  #require(serverId: string, id: number): WipeRunRecord {
    const found = this.get(serverId, id);

    if (found === null) {
      throw new Error(
        `a execução de wipe ${String(id)} do servidor "${serverId}" sumiu do banco entre a ` +
          'escrita e a leitura',
      );
    }

    return found;
  }

  #toRecord(row: RunRow): WipeRunRecord {
    const steps = this.#db
      .prepare(
        `SELECT run_id, step, position, status, started_at, finished_at, message
           FROM wipe_run_steps WHERE run_id = @id ORDER BY position ASC`,
      )
      .all({ id: row.id }) as StepRow[];

    return {
      id: row.id,
      serverId: row.server_id,
      planId: row.plan_id,
      operationId: row.operation_id,
      kind: (['cadence', 'forced', 'manual'] as readonly string[]).includes(row.kind)
        ? (row.kind as WipePlanKind)
        : 'manual',
      bpPolicy: (['keep', 'wipe', 'wipe_except_vip'] as readonly string[]).includes(row.bp_policy)
        ? (row.bp_policy as BpPolicy)
        : 'keep',
      fullWipe: row.full_wipe === 1,
      startedAt: row.started_at,
      wipeAt: row.wipe_at,
      finishedAt: row.finished_at,
      status: (WIPE_RUN_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as WipeRunStatus)
        : 'failed',
      backupPath: row.backup_path,
      mapBefore: parseWorld(row.map_before),
      mapAfter: parseWorld(row.map_after),
      mapDecision: parseDecision(row.map_decision),
      saveCreatedBefore: row.save_created_before,
      saveCreatedAfter: row.save_created_after,
      message: row.message,
      steps: steps
        .filter((step): step is StepRow & { step: WipeRunStep } =>
          (WIPE_RUN_STEPS as readonly string[]).includes(step.step),
        )
        .map((step) => ({
          step: step.step,
          position: step.position,
          status: (WIPE_STEP_STATUSES as readonly string[]).includes(step.status)
            ? (step.status as WipeStepStatus)
            : 'pending',
          startedAt: step.started_at,
          finishedAt: step.finished_at,
          message: step.message,
        })),
    };
  }
}

// ------------------------------------------------------------
//  Leitura tolerante
// ------------------------------------------------------------

/**
 * `1440,360,60` -> `[1440, 360, 60]`, do maior para o menor.
 *
 * Texto vazio é uma escolha legítima ("não quero avisos"), e por
 * isso ele devolve lista vazia em vez de cair no padrão — o
 * contrário faria o admin desligar os avisos e vê-los voltarem no
 * próximo boot.
 */
export function parseOffsets(
  raw: string | undefined,
  fallback: readonly number[],
): readonly number[] {
  if (raw === undefined) {
    return fallback;
  }

  if (raw.trim() === '') {
    return [];
  }

  const parsed = raw
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter(
      (value) => Number.isFinite(value) && value > 0 && value <= MAX_ANNOUNCE_OFFSET_MINUTES,
    )
    .map((value) => Math.round(value));

  // Sem repetição, e do maior para o menor: dois avisos no mesmo
  // minuto sairiam duas vezes no chat.
  return [...new Set(parsed)].sort((a, b) => b - a).slice(0, MAX_ANNOUNCE_OFFSETS);
}

function parsePatterns(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === 'string' && value !== '');
  } catch {
    // JSON quebrado na lista do full wipe cai para VAZIO, e não
    // para um palpite: o lado seguro desta chave é não apagar
    // nada.
    return [];
  }
}

/**
 * A decisão congelada, relida do JSON.
 *
 * TOLERANTE como o resto deste arquivo: linha estragada vira
 * `null`, e `null` quer dizer "ainda não decidiu" — o passo
 * `configurar` decide de novo, que é exatamente o que ele fazia
 * antes de a coluna existir. Um `throw` aqui derrubaria a leitura
 * da execução inteira, e com ela a tela do histórico.
 */
function parseDecision(raw: string | null): WipeMapDecision | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const decision = parsed as Partial<{ source: string; mapPoolId: number }>;

    if (decision.source === 'keep' || decision.source === 'undecided') {
      return { source: decision.source };
    }

    return decision.source === 'entry' && typeof decision.mapPoolId === 'number'
      ? { source: 'entry', mapPoolId: decision.mapPoolId }
      : null;
  } catch {
    return null;
  }
}

function parseWorld(raw: string | null): WipeWorld | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const world = parsed as Partial<WipeWorld>;

    return {
      level: typeof world.level === 'string' ? world.level : null,
      seed: typeof world.seed === 'string' ? world.seed : null,
      worldSize: typeof world.worldSize === 'number' ? world.worldSize : null,
      levelUrl: typeof world.levelUrl === 'string' ? world.levelUrl : null,
      mapPoolId: typeof world.mapPoolId === 'number' ? world.mapPoolId : null,
      drawn: world.drawn === true,
    };
  } catch {
    return null;
  }
}
