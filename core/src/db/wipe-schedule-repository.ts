// ============================================================
//  wipe-schedule-repository.ts  -  a configuração do wipe e o
//  calendário MATERIALIZADO.
//
//  Duas responsabilidades que andam juntas de propósito: mudar a
//  configuração OBRIGA a recalcular a agenda, e separá-las em dois
//  arquivos criaria o intervalo em que o banco diz uma coisa e a
//  tela mostra outra.
//
//  Quem calcula é wipe/schedule.ts — puro, sem banco. Aqui é só
//  persistência e reconciliação. Nada neste arquivo para servidor,
//  apaga arquivo ou manda RCON: executar é da Frente D (Docs/17).
//
//  ------------------------------------------------------------
//  ####  A AGENDA É MATERIALIZADA, E NÃO CALCULADA NA HORA  ####
//
//  Um wipe agendado é algo que se EDITA — adiar, trocar a política
//  de blueprint, escolher o mapa — e não dá para editar o
//  resultado de uma função. Por isso o cálculo vira linha.
//
//  ------------------------------------------------------------
//  ####  RECONCILIAR, E NÃO REGERAR  ####
//
//  A tentação é apagar tudo o que é futuro e reescrever do
//  cálculo. Isso funciona uma vez e estraga duas coisas:
//
//   1. o adiamento que o admin fez ontem some;
//   2. o `id` de cada wipe muda a cada reconciliação, e o painel
//      que estava com a tela aberta passa a mandar PATCH para
//      linhas que não existem mais.
//
//  Então: o que veio do cálculo e não foi tocado é atualizado no
//  lugar; o que o admin editou (`pinned`) ou criou (`manual`) é
//  deixado em paz; e o passado é intocável, sempre.
//
//  ------------------------------------------------------------
//  ####  QUEM CHAMA A RECONCILIAÇÃO  ####
//
//  O boot (index.ts) e o PUT das configurações (routes/wipe.ts).
//  NÃO existe relógio próprio aqui: o horizonte é de 90 dias, e um
//  processo que fica três meses no ar sem reiniciar e sem ninguém
//  mexer na cadência é o único caso que ficaria curto. Quando a
//  execução entrar (Frente D) ela vai ter um relógio de verdade —
//  o que dispara o wipe na hora — e reconciliar na mesma batida é
//  o lugar certo, em vez de dois relógios discordando.
// ============================================================

import { ApiError } from '../http/error-response.js';
import {
  BP_POLICIES,
  COLLISION_POLICIES,
  MAP_SOURCES,
  type BpPolicy,
  type CollisionPolicy,
  type MapSource,
  type WipePlan,
  type WipePlanStatus,
  type WipeSettings,
} from '../types/wipe.js';
import {
  DEFAULT_WIPE_SETTINGS,
  buildSchedule,
  isValidTimeZone,
  parseTimeOfDay,
} from '../wipe/schedule.js';
import type { AgentDatabase } from './database.js';

/**
 * Quantos dias à frente a agenda é materializada.
 *
 * 90 dias = três wipes forçados, que é o horizonte que a tela de
 * "próximos 90 dias" mostra (Docs/16 §9.1). Materializar um ano
 * criaria cinquenta linhas que ninguém olha e que a primeira
 * mudança de cadência apagaria inteiras.
 */
export const DEFAULT_WIPE_HORIZON_DAYS = 90;

/**
 * `fixed` sem entrada apontada não é meio-caminho: é `pool` com a
 * etiqueta errada.
 *
 * ####  A LINHA GRAVADA NÃO PODE MENTIR  ####
 *
 * `fixed` quer dizer "ESTA entrada da fila, esta mesma", e o
 * `mapPoolId` É a escolha. Sem ele o painel mostra "escolhido a
 * dedo" num wipe em que ninguém escolheu nada, e a execução pega a
 * cabeça da fila como em qualquer outro — o admin lê uma coisa na
 * agenda e o servidor sobe outra.
 *
 * Isto NÃO é a mesma coisa que um ponteiro que morreu depois: uma
 * entrada apagada, consumida ou sem a marca de versão é uma
 * escolha que existiu, e para ela a queda para a fila é de
 * propósito (ver `mapOfPlan`, em wipe/next-wipe.ts). Aqui não
 * houve escolha nenhuma para respeitar.
 *
 * A conta é feita sobre o estado FINAL da linha, e não sobre o que
 * veio no corpo: mandar só `mapSource: 'fixed'` num plano que já
 * aponta a entrada #7 continua valendo.
 *
 * @throws {ApiError} 400
 */
function assertMapChoice(mapSource: MapSource, mapPoolId: number | null): void {
  if (mapSource === 'fixed' && mapPoolId === null) {
    throw new ApiError(
      'WIPE_FIXED_MAP_WITHOUT_ENTRY',
      'Este wipe está marcado como "mapa escolhido a dedo" e não aponta entrada nenhuma da fila. ' +
        'Mande o `mapPoolId` da entrada que deve subir, ou `mapSource: "pool"` para o wipe pegar ' +
        'a primeira pronta da fila.',
      400,
    );
  }
}

/**
 * Os status que a reconciliação pode reescrever.
 *
 * Fora deles a linha é fato consumado — um wipe que rodou, que
 * falhou ou que um humano pulou — e reescrevê-la seria apagar o
 * que aconteceu para caber no que o cálculo diz que deveria ter
 * acontecido.
 */
const REWRITABLE: readonly WipePlanStatus[] = ['planned', 'absorbed'];

/** O que muda num PATCH. Campo ausente = não mexe. */
export interface WipePlanPatch {
  readonly scheduledAt?: number | undefined;
  readonly bpPolicy?: BpPolicy | undefined;
  readonly mapSource?: MapSource | undefined;
  readonly mapPoolId?: number | null | undefined;
  readonly note?: string | null | undefined;
}

/** Um wipe marcado à mão. */
export interface WipePlanInput {
  readonly scheduledAt: number;
  readonly bpPolicy: BpPolicy;
  readonly mapSource?: MapSource | undefined;
  readonly mapPoolId?: number | null | undefined;
  readonly note?: string | null | undefined;
}

/** O que a reconciliação fez, para o log e para o teste. */
export interface ReconcileResult {
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
}

/**
 * Só a leitura da agenda.
 *
 * É o que as Frentes F (os avisos) e G (o calendário dentro do
 * jogo) recebem: elas precisam saber QUANDO é o próximo wipe e o
 * que ele leva, e não têm o que escrever aqui. Uma dependência que
 * só lê não consegue reconciliar por engano.
 */
export interface WipeScheduleReader {
  getSettings(serverId: string): WipeSettings;
  listPlans(
    serverId: string,
    options?: { readonly from?: number; readonly to?: number },
  ): readonly WipePlan[];
  getPlan(serverId: string, id: number): WipePlan | null;
  /** O próximo que vai acontecer de verdade. `null` se não houver. */
  nextPlan(serverId: string, now?: number): WipePlan | null;
}

// ------------------------------------------------------------
//  A configuração: chave/valor por servidor
//
//  As chaves são planas e com o prefixo do bloco a que pertencem.
//  Uma chave nova numa frente futura (a Frente D grava os avisos,
//  o backup e a lista do full wipe aqui) não precisa de migração —
//  e é por isso que isto é uma tabela, e não um `JSON.stringify`
//  do objeto inteiro: assim uma chave corrompida não leva as
//  outras nove junto.
// ------------------------------------------------------------

const KEY = {
  cadenceEnabled: 'cadence.enabled',
  cadenceEveryDays: 'cadence.everyDays',
  cadenceAnchorAt: 'cadence.anchorAt',
  cadenceTimeOfDay: 'cadence.timeOfDay',
  cadenceTimeZone: 'cadence.timeZone',
  cadenceBpPolicy: 'cadence.bpPolicy',
  forcedBpPolicy: 'forced.bpPolicy',
  collisionPolicy: 'collision.policy',
  collisionWindowHours: 'collision.windowHours',
} as const;

function isBpPolicy(value: string): value is BpPolicy {
  return (BP_POLICIES as readonly string[]).includes(value);
}

function isCollisionPolicy(value: string): value is CollisionPolicy {
  return (COLLISION_POLICIES as readonly string[]).includes(value);
}

function isMapSource(value: string): value is MapSource {
  return (MAP_SOURCES as readonly string[]).includes(value);
}

interface SettingRow {
  readonly key: string;
  readonly value: string;
}

interface PlanRow {
  readonly id: number;
  readonly server_id: string;
  readonly scheduled_at: number;
  readonly kind: string;
  readonly bp_policy: string;
  readonly map_source: string;
  readonly map_pool_id: number | null;
  readonly status: string;
  readonly absorbed_by: number | null;
  readonly generated_for: number | null;
  readonly pinned: number;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const PLAN_COLUMNS = `id, server_id, scheduled_at, kind, bp_policy, map_source, map_pool_id,
  status, absorbed_by, generated_for, pinned, note, created_at, updated_at`;

/**
 * ####  CADA SERVIDOR TEM A SUA AGENDA  ####
 *
 * Configuração, planos e reconciliação são POR SERVIDOR, e por
 * isso `serverId` é o primeiro argumento de tudo aqui. Dois
 * servidores zerando às 19:00 da mesma quinta é o caso normal, não
 * a exceção — e uma agenda só para a máquina inteira obrigaria os
 * dois a zerar juntos para sempre.
 */
export class WipeScheduleRepository implements WipeScheduleReader {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ----------------------------------------------------------
  //  CONFIGURAÇÃO
  // ----------------------------------------------------------

  /**
   * A configuração, com os padrões por cima do que estiver no
   * banco.
   *
   * ####  LEITURA TOLERANTE, DE PROPÓSITO  ####
   *
   * Valor inválido numa chave cai no padrão DAQUELA chave, e as
   * outras continuam valendo. A alternativa — lançar — faria um
   * `everyDays` digitado errado direto no SQLite derrubar o boot do
   * agente inteiro, e o sintoma não apontaria para a causa.
   *
   * Quem garante que valor inválido não ENTRA é a borda HTTP. Aqui
   * a garantia é outra: o que sai daqui é sempre utilizável.
   */
  getSettings(serverId: string): WipeSettings {
    const rows = this.#db
      .prepare('SELECT key, value FROM wipe_settings WHERE server_id = @server_id')
      .all({ server_id: serverId }) as SettingRow[];

    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const defaults = DEFAULT_WIPE_SETTINGS;

    const text = (key: string, fallback: string): string => stored.get(key) ?? fallback;

    const integer = (key: string, fallback: number, min: number): number => {
      const raw = stored.get(key);

      if (raw === undefined) {
        return fallback;
      }

      const parsed = Number(raw);

      return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
    };

    const bpPolicy = (key: string, fallback: BpPolicy): BpPolicy => {
      const raw = stored.get(key);

      return raw !== undefined && isBpPolicy(raw) ? raw : fallback;
    };

    const timeOfDay = text(KEY.cadenceTimeOfDay, defaults.cadence.timeOfDay);
    const timeZone = text(KEY.cadenceTimeZone, defaults.cadence.timeZone);
    const collisionPolicy = text(KEY.collisionPolicy, defaults.collision.policy);

    return {
      cadence: {
        enabled: text(KEY.cadenceEnabled, defaults.cadence.enabled ? '1' : '0') === '1',
        everyDays: integer(KEY.cadenceEveryDays, defaults.cadence.everyDays, 1),
        // Epoch ms, como toda data deste banco — e guardado como
        // TEXTO da tabela chave/valor, que é o que ela tem.
        anchorAt: integer(KEY.cadenceAnchorAt, defaults.cadence.anchorAt, 0),
        timeOfDay: parseTimeOfDay(timeOfDay) === null ? defaults.cadence.timeOfDay : timeOfDay,
        timeZone: isValidTimeZone(timeZone) ? timeZone : defaults.cadence.timeZone,
        bpPolicy: bpPolicy(KEY.cadenceBpPolicy, defaults.cadence.bpPolicy),
      },
      forced: {
        bpPolicy: bpPolicy(KEY.forcedBpPolicy, defaults.forced.bpPolicy),
      },
      collision: {
        policy: isCollisionPolicy(collisionPolicy) ? collisionPolicy : defaults.collision.policy,
        windowHours: integer(KEY.collisionWindowHours, defaults.collision.windowHours, 0),
      },
    };
  }

  /**
   * Grava a configuração inteira.
   *
   * NÃO reconcilia: quem chama decide quando materializar, porque a
   * rota quer gravar e reconciliar na MESMA resposta e o boot quer
   * só reconciliar. Amarrar as duas aqui esconderia uma escrita de
   * dezenas de linhas dentro de um `saveSettings`.
   */
  saveSettings(serverId: string, settings: WipeSettings, now: number = Date.now()): WipeSettings {
    const entries: ReadonlyArray<readonly [string, string]> = [
      [KEY.cadenceEnabled, settings.cadence.enabled ? '1' : '0'],
      [KEY.cadenceEveryDays, String(settings.cadence.everyDays)],
      [KEY.cadenceAnchorAt, String(Math.trunc(settings.cadence.anchorAt))],
      [KEY.cadenceTimeOfDay, settings.cadence.timeOfDay],
      [KEY.cadenceTimeZone, settings.cadence.timeZone],
      [KEY.cadenceBpPolicy, settings.cadence.bpPolicy],
      [KEY.forcedBpPolicy, settings.forced.bpPolicy],
      [KEY.collisionPolicy, settings.collision.policy],
      [KEY.collisionWindowHours, String(settings.collision.windowHours)],
    ];

    const statement = this.#db.prepare(
      `INSERT INTO wipe_settings (server_id, key, value, updated_at)
       VALUES (@server_id, @key, @value, @updated_at)
       ON CONFLICT (server_id, key) DO UPDATE SET
         value      = excluded.value,
         updated_at = excluded.updated_at`,
    );

    // Transação: a configuração é lida como um bloco só. Gravar
    // chave a chave sem ela deixaria uma leitura concorrente ver
    // metade da cadência nova com metade da antiga — e é a metade
    // que decide QUANDO zerar o servidor.
    const write = this.#db.transaction((): void => {
      for (const [key, value] of entries) {
        statement.run({ server_id: serverId, key, value, updated_at: now });
      }
    });

    write();

    return this.getSettings(serverId);
  }

  // ----------------------------------------------------------
  //  PLANOS
  // ----------------------------------------------------------

  listPlans(
    serverId: string,
    options: { readonly from?: number; readonly to?: number } = {},
  ): readonly WipePlan[] {
    // O servidor está SEMPRE no WHERE: ele não é um filtro que o
    // chamador escolhe, é a fronteira da consulta.
    const clauses: string[] = ['server_id = @server_id'];
    const params: Record<string, string | number> = { server_id: serverId };

    if (options.from !== undefined) {
      clauses.push('scheduled_at >= @from');
      params['from'] = options.from;
    }

    if (options.to !== undefined) {
      clauses.push('scheduled_at <= @to');
      params['to'] = options.to;
    }

    const rows = this.#db
      .prepare(
        `SELECT ${PLAN_COLUMNS} FROM wipe_plans
          WHERE ${clauses.join(' AND ')}
          ORDER BY scheduled_at ASC, id ASC`,
      )
      .all(params) as PlanRow[];

    return rows.map(toPlan);
  }

  getPlan(serverId: string, id: number): WipePlan | null {
    const row = this.#db
      .prepare(`SELECT ${PLAN_COLUMNS} FROM wipe_plans WHERE server_id = @server_id AND id = @id`)
      .get({ server_id: serverId, id }) as PlanRow | undefined;

    return row === undefined ? null : toPlan(row);
  }

  /**
   * O próximo wipe que VAI acontecer.
   *
   * `absorbed` fica de fora: ele está na tabela para a tela poder
   * explicar um dia sem wipe, não para ser executado. `skipped`
   * também, pela razão óbvia.
   */
  nextPlan(serverId: string, now: number = Date.now()): WipePlan | null {
    const row = this.#db
      .prepare(
        `SELECT ${PLAN_COLUMNS} FROM wipe_plans
          WHERE server_id = @server_id AND status = 'planned' AND scheduled_at > @now
          ORDER BY scheduled_at ASC LIMIT 1`,
      )
      .get({ server_id: serverId, now }) as PlanRow | undefined;

    return row === undefined ? null : toPlan(row);
  }

  /**
   * Agenda um wipe à mão.
   *
   * Nasce `manual` e `pinned`: foi um humano que pediu, e a
   * reconciliação não pode desfazer isso na próxima vez que a
   * cadência mudar.
   *
   * @throws {ApiError} 400 no passado ou em `fixed` sem entrada
   *   apontada, 409 se já houver outro no mesmo instante.
   */
  createPlan(serverId: string, input: WipePlanInput, now: number = Date.now()): WipePlan {
    if (input.scheduledAt <= now) {
      throw new ApiError(
        'WIPE_SCHEDULE_IN_THE_PAST',
        'Não dá para agendar um wipe para um instante que já passou.',
        400,
      );
    }

    this.#assertFree(serverId, input.scheduledAt, null);
    assertMapChoice(input.mapSource ?? 'pool', input.mapPoolId ?? null);

    const result = this.#db
      .prepare(
        `INSERT INTO wipe_plans
           (server_id, scheduled_at, kind, bp_policy, map_source, map_pool_id, status,
            absorbed_by, generated_for, pinned, note, created_at, updated_at)
         VALUES
           (@server_id, @at, 'manual', @bp, @map_source, @map_pool_id, 'planned',
            NULL, NULL, 1, @note, @now, @now)`,
      )
      .run({
        server_id: serverId,
        at: input.scheduledAt,
        bp: input.bpPolicy,
        map_source: input.mapSource ?? 'pool',
        map_pool_id: input.mapPoolId ?? null,
        note: input.note ?? null,
        now,
      });

    const created = this.getPlan(serverId, Number(result.lastInsertRowid));

    if (created === null) {
      throw new Error('a linha do wipe sumiu logo depois de ser inserida');
    }

    return created;
  }

  /**
   * Edita um wipe agendado: adiar, trocar a política, escolher o
   * mapa, anotar o motivo.
   *
   * ####  EDITAR É FIXAR  ####
   *
   * Todo PATCH liga o `pinned`. Sem isso, adiar o wipe de sábado
   * para domingo duraria até a próxima reconciliação — que roda no
   * boot e a cada mudança de configuração — e o wipe voltaria
   * sozinho para sábado sem ninguém ter mexido.
   *
   * @throws {ApiError} 404 desconhecido, 409 já consumado ou data
   *   de forçado, 400 no passado ou em `fixed` sem entrada
   *   apontada.
   */
  updatePlan(
    serverId: string,
    id: number,
    patch: WipePlanPatch,
    now: number = Date.now(),
  ): WipePlan {
    const current = this.#editable(serverId, id, 'editado');
    const scheduledAt = patch.scheduledAt ?? current.scheduledAt;

    if (patch.scheduledAt !== undefined && patch.scheduledAt !== current.scheduledAt) {
      if (current.kind === 'forced') {
        // A data do forçado é da Facepunch. Deixar alguém movê-la
        // faria o agente prometer um wipe para uma hora em que o
        // servidor já vai estar fora do ar de qualquer jeito.
        throw new ApiError(
          'WIPE_FORCED_DATE_IS_FIXED',
          'A data do wipe forçado é da Facepunch (primeira quinta do mês, 19:00 UTC) e não pode ' +
            'ser mudada. A política de blueprint dele, sim.',
          409,
        );
      }

      if (scheduledAt <= now) {
        throw new ApiError(
          'WIPE_SCHEDULE_IN_THE_PAST',
          'Não dá para mover um wipe para um instante que já passou.',
          400,
        );
      }

      this.#assertFree(serverId, scheduledAt, id);
    }

    const mapSource = patch.mapSource ?? current.mapSource;
    const mapPoolId = patch.mapPoolId === undefined ? current.mapPoolId : patch.mapPoolId;

    assertMapChoice(mapSource, mapPoolId);

    this.#db
      .prepare(
        `UPDATE wipe_plans
            SET scheduled_at = @at,
                bp_policy    = @bp,
                map_source   = @map_source,
                map_pool_id  = @map_pool_id,
                note         = @note,
                pinned       = 1,
                updated_at   = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({
        server_id: serverId,
        id,
        at: scheduledAt,
        bp: patch.bpPolicy ?? current.bpPolicy,
        map_source: mapSource,
        map_pool_id: mapPoolId,
        note: patch.note === undefined ? current.note : patch.note,
        now,
      });

    const updated = this.getPlan(serverId, id);

    if (updated === null) {
      throw new Error('a linha do wipe sumiu logo depois de ser alterada');
    }

    return updated;
  }

  /**
   * PULA um wipe da agenda.
   *
   * ####  O FORÇADO NÃO SAI  ####
   *
   * Ele não é uma escolha nossa: sem o servidor zerado, o mundo
   * antigo não carrega na versão nova. Apagar a linha só faria o
   * painel esconder o que vai acontecer de qualquer jeito — por
   * isso aqui é 409 com explicação, e não um 204 silencioso.
   *
   * ####  E PULAR NÃO É APAGAR  ####
   *
   * A linha GERADA vira `skipped` e fica na agenda. Apagá-la faria
   * a reconciliação seguinte recriá-la no mesmo instante — o wipe
   * "pulado" voltaria sozinho. O que é do humano (`manual`) some de
   * verdade: nada o recria.
   *
   * @throws {ApiError} 404 desconhecido, 409 forçado ou já
   *   consumado.
   */
  skipPlan(serverId: string, id: number, now: number = Date.now()): WipePlan | null {
    const current = this.#editable(serverId, id, 'removido');

    if (current.kind === 'forced') {
      throw new ApiError(
        'WIPE_FORCED_CANNOT_BE_SKIPPED',
        'O wipe forçado não pode ser pulado: ele acontece com ou sem o agente. A atualização ' +
          'mensal do Rust muda o protocolo e invalida o save do mundo — o que dá para escolher é ' +
          'o que ele leva (a política de blueprint), e não se ele acontece.',
        409,
      );
    }

    if (current.kind === 'manual') {
      this.#db
        .prepare('DELETE FROM wipe_plans WHERE server_id = @server_id AND id = @id')
        .run({ server_id: serverId, id });

      return null;
    }

    this.#db
      .prepare(
        `UPDATE wipe_plans
            SET status     = 'skipped',
                pinned     = 1,
                updated_at = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({ server_id: serverId, id, now });

    return this.getPlan(serverId, id);
  }

  // ----------------------------------------------------------
  //  RECONCILIAÇÃO
  // ----------------------------------------------------------

  /**
   * Faz a tabela concordar com o cálculo, sem atropelar humano.
   *
   * O que ela mexe: linhas geradas (`cadence`/`forced`), não
   * `pinned`, em `planned`/`absorbed`, e no FUTURO.
   *
   * O que ela nunca mexe: passado, `manual`, `pinned`, e qualquer
   * linha em execução ou já concluída.
   */
  reconcile(
    serverId: string,
    now: number = Date.now(),
    horizonDays = DEFAULT_WIPE_HORIZON_DAYS,
  ): ReconcileResult {
    const settings = this.getSettings(serverId);
    const horizon = now + horizonDays * 86_400_000;
    const planned = buildSchedule(settings, now, horizon);

    const run = this.#db.transaction((): ReconcileResult => {
      const wanted = new Map(planned.map((plan) => [plan.scheduledAt, plan]));

      const existing = this.#db
        .prepare(
          `SELECT ${PLAN_COLUMNS} FROM wipe_plans
            WHERE server_id = @server_id AND scheduled_at > @now`,
        )
        .all({ server_id: serverId, now }) as PlanRow[];

      let created = 0;
      let removed = 0;
      const updated = new Set<number>();

      for (const row of existing) {
        const editable =
          row.kind !== 'manual' &&
          row.pinned === 0 &&
          (REWRITABLE as readonly string[]).includes(row.status);

        if (!editable) {
          // Linha de humano (ou já consumada). Ela consome DOIS
          // instantes do cálculo:
          //
          //   `scheduled_at`   onde ela está — senão o INSERT lá
          //                    embaixo esbarraria no UNIQUE;
          //   `generated_for`  de onde ela saiu — senão a data
          //                    original seria recriada, e adiar um
          //                    wipe viraria dois wipes.
          wanted.delete(row.scheduled_at);

          if (row.generated_for !== null) {
            wanted.delete(row.generated_for);
          }

          continue;
        }

        const want = wanted.get(row.scheduled_at);

        if (want === undefined) {
          // Sem `server_id` no WHERE: a linha saiu do SELECT acima,
          // que já filtrou por servidor, e o id é único no banco.
          this.#db.prepare('DELETE FROM wipe_plans WHERE id = @id').run({ id: row.id });
          removed += 1;
          continue;
        }

        const status: WipePlanStatus = want.absorbedBy === null ? 'planned' : 'absorbed';
        const note = absorbedNote(want);

        if (
          row.kind !== want.kind ||
          row.bp_policy !== want.bpPolicy ||
          row.status !== status ||
          row.note !== note ||
          row.generated_for !== row.scheduled_at
        ) {
          this.#db
            .prepare(
              `UPDATE wipe_plans
                  SET kind = @kind, bp_policy = @bp, status = @status, note = @note,
                      generated_for = @at, updated_at = @now
                WHERE id = @id`,
            )
            .run({
              id: row.id,
              kind: want.kind,
              bp: want.bpPolicy,
              status,
              note,
              at: row.scheduled_at,
              now,
            });

          updated.add(row.id);
        }

        wanted.delete(row.scheduled_at);
      }

      // ####  `generated_for` NASCE IGUAL A `scheduled_at`  ####
      //
      // É o instante que a REGRA produziu. Quem adiar a linha muda
      // o `scheduled_at` e deixa este como estava — e é essa
      // diferença que a reconciliação lê para não recriar o wipe no
      // lugar de onde ele saiu.
      const insert = this.#db.prepare(
        `INSERT INTO wipe_plans
           (server_id, scheduled_at, kind, bp_policy, map_source, map_pool_id, status,
            absorbed_by, generated_for, pinned, note, created_at, updated_at)
         VALUES
           (@server_id, @at, @kind, @bp, 'pool', NULL, @status,
            NULL, @at, 0, @note, @now, @now)
         ON CONFLICT (server_id, scheduled_at) DO NOTHING`,
      );

      for (const [scheduledAt, plan] of wanted) {
        const result = insert.run({
          server_id: serverId,
          at: scheduledAt,
          kind: plan.kind,
          bp: plan.bpPolicy,
          status: plan.absorbedBy === null ? 'planned' : 'absorbed',
          note: absorbedNote(plan),
          now,
        });

        created += Number(result.changes);
      }

      // ####  O `absorbed_by` SÓ DÁ PARA RESOLVER NO FIM  ####
      //
      // O cálculo devolve o INSTANTE do forçado que absorveu (nele
      // ainda não existe id nenhum); a coluna guarda o ID da linha.
      // Como o forçado que absorve pode ter acabado de ser
      // inserido, a tradução acontece depois de todo mundo estar na
      // tabela.
      const forcedIdOf = new Map(
        (
          this.#db
            .prepare(
              `SELECT id, scheduled_at FROM wipe_plans
                WHERE server_id = @server_id AND kind = 'forced'`,
            )
            .all({ server_id: serverId }) as ReadonlyArray<{ id: number; scheduled_at: number }>
        ).map((row) => [row.scheduled_at, row.id]),
      );

      for (const plan of planned) {
        const absorbedBy =
          plan.absorbedBy === null ? null : (forcedIdOf.get(plan.absorbedBy) ?? null);

        const row = this.#db
          .prepare(
            `SELECT id FROM wipe_plans
              WHERE server_id = @server_id AND scheduled_at = @at AND kind <> 'manual'
                AND pinned = 0 AND status IN ('planned', 'absorbed')
                AND absorbed_by IS NOT @absorbed_by`,
          )
          .get({ server_id: serverId, at: plan.scheduledAt, absorbed_by: absorbedBy }) as
          | { id: number }
          | undefined;

        if (row === undefined) {
          continue;
        }

        this.#db
          .prepare(
            'UPDATE wipe_plans SET absorbed_by = @absorbed_by, updated_at = @now WHERE id = @id',
          )
          .run({ id: row.id, absorbed_by: absorbedBy, now });

        updated.add(row.id);
      }

      return { created, updated: updated.size, removed };
    });

    return run();
  }

  /**
   * A reconciliação de todos os servidores, para o boot.
   *
   * Um servidor que falhar não derruba os outros — e não derruba a
   * subida do agente. O erro sobe para quem chamou decidir o que
   * logar, servidor a servidor.
   */
  reconcileAll(
    serverIds: readonly string[],
    now: number = Date.now(),
    horizonDays = DEFAULT_WIPE_HORIZON_DAYS,
  ): ReadonlyMap<string, ReconcileResult | Error> {
    const results = new Map<string, ReconcileResult | Error>();

    for (const serverId of serverIds) {
      try {
        results.set(serverId, this.reconcile(serverId, now, horizonDays));
      } catch (error) {
        results.set(serverId, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return results;
  }

  // ----------------------------------------------------------
  //  Internos
  // ----------------------------------------------------------

  /**
   * A linha que existe e ainda dá para mexer.
   *
   * @throws {ApiError} 404 quando não existe, 409 quando o wipe já
   *   rodou, falhou ou foi pulado — nesses três a linha é fato
   *   consumado, e editar o passado não muda o que aconteceu.
   */
  #editable(serverId: string, id: number, verb: string): WipePlan {
    const current = this.getPlan(serverId, id);

    if (current === null) {
      throw new ApiError(
        'WIPE_PLAN_NOT_FOUND',
        `Não existe wipe agendado com o id ${String(id)} em "${serverId}".`,
        404,
      );
    }

    if (!REWRITABLE.includes(current.status)) {
      throw new ApiError(
        'WIPE_PLAN_NOT_EDITABLE',
        `Este wipe está em "${current.status}" e não pode mais ser ${verb}.`,
        409,
      );
    }

    return current;
  }

  /**
   * @throws {ApiError} 409 quando já há outro wipe naquele
   *   instante.
   *
   * Dois wipes no mesmo segundo são uma parada de servidor contada
   * duas vezes — e o UNIQUE do banco recusaria isso com um 500 sem
   * explicação.
   */
  #assertFree(serverId: string, scheduledAt: number, exceptId: number | null): void {
    const clash = this.#db
      .prepare(
        `SELECT id FROM wipe_plans
          WHERE server_id = @server_id AND scheduled_at = @at AND id <> @except`,
      )
      .get({ server_id: serverId, at: scheduledAt, except: exceptId ?? 0 }) as
      | { id: number }
      | undefined;

    if (clash !== undefined) {
      throw new ApiError(
        'WIPE_SCHEDULE_CONFLICT',
        `Já existe um wipe agendado para ${new Date(scheduledAt).toISOString()} neste servidor.`,
        409,
      );
    }
  }

  // ======================================================
  //  O QUE A EXECUÇÃO ESCREVE DE VOLTA  (Frente D)
  // ======================================================
  //
  //  Acrescentado no fim, e é um método só. Ele fica AQUI, e não
  //  no repositório das execuções, porque quem escreve na tabela
  //  `wipe_plans` é este arquivo: dois escritores na mesma tabela
  //  são dois lugares para consertar quando a regra da agenda
  //  mudar, e nenhum dos dois enxerga o outro.
  //
  //  ####  SEM ISTO, O SERVIDOR ZERA DUAS VEZES  ####
  //
  //  Um plano executado que continuasse `planned` seria disparado
  //  de novo na volta seguinte do relógio (wipe/scheduler.ts) — e
  //  a segunda vez pegaria um mundo de minutos de idade.

  /**
   * Marca um plano como consumido pela execução.
   *
   * Um plano que um humano já pulou (`skipped`), que foi absorvido
   * ou que já terminou (`done`) não volta atrás porque uma
   * execução atrasada terminou: a decisão do humano e o wipe que
   * já aconteceu valem mais do que uma escrita fora de hora.
   *
   * ####  `failed` ENTRA, E É O CONSERTO DE UM ESTADO ETERNO  ####
   *
   * A execução que falha marca o plano `failed`. Sem ele nesta
   * lista, a RETOMADA bem-sucedida não pegava linha nenhuma — o
   * wipe acontecia, o mundo trocava, o run ficava `done`, e a
   * Agenda continuava dizendo que aquele wipe falhou. Para sempre.
   * O admin lia isso e podia disparar um "WIPAR AGORA" que
   * consumiria uma segunda entrada da curadoria.
   *
   * E isto NÃO reabre caminho para o wipe acontecer duas vezes:
   * quem dispara sozinho é o relógio, e `duePlans` só enxerga
   * `planned` — um plano `failed` que vira `done` sai da fila do
   * relógio pela mesma porta por onde entrou.
   */
  markPlanStatus(
    serverId: string,
    id: number,
    status: 'running' | 'done' | 'failed',
    now: number = Date.now(),
  ): WipePlan | null {
    this.#db
      .prepare(
        `UPDATE wipe_plans SET status = @status, updated_at = @now
          WHERE server_id = @server_id AND id = @id
            AND status IN ('planned', 'running', 'failed')`,
      )
      .run({ server_id: serverId, id, status, now });

    return this.getPlan(serverId, id);
  }

  /**
   * Os planos vencidos que ninguém executou.
   *
   * ####  O PASSADO CONTA, E ELE CONTA INTEIRO  ####
   *
   * A janela não tem piso: um plano de três dias atrás, com o
   * agente que ficou desligado esses três dias, CONTINUA sendo um
   * wipe que o dono do servidor pediu. Descartá-lo por ser velho
   * transformaria "o agente estava fora do ar" em "o wipe não
   * aconteceu, e ninguém falou nada".
   *
   * Quem decide o que fazer com um plano muito atrasado é o
   * relógio de wipe/scheduler.ts, que tem o contexto para avisar.
   */
  duePlans(serverId: string, until: number): readonly WipePlan[] {
    return this.listPlans(serverId, { to: until }).filter(
      (plan) => plan.status === 'planned' && plan.scheduledAt <= until,
    );
  }
}

/**
 * A explicação do `absorbed`, escrita na hora de gerar.
 *
 * Fica em `note` — o mesmo campo que o admin usa — porque em linha
 * gerada e não `pinned` ninguém mais escreve ali, e uma coluna a
 * mais só para isto seria uma coluna vazia em 99% das linhas. No
 * instante em que alguém edita a linha, o `pinned` liga e este
 * texto para de ser reescrito.
 */
function absorbedNote(plan: { readonly absorbedBy: number | null }): string | null {
  if (plan.absorbedBy === null) {
    return null;
  }

  return `Cancelado: cai perto do wipe forçado de ${new Date(plan.absorbedBy).toISOString()}.`;
}

function toPlan(row: PlanRow): WipePlan {
  return {
    id: row.id,
    serverId: row.server_id,
    scheduledAt: row.scheduled_at,
    // Os três `as` são o contrato do CHECK da migração 23: o banco
    // recusa qualquer outro valor, e repetir a validação aqui só
    // criaria um segundo lugar para a lista de status envelhecer.
    kind: row.kind as WipePlan['kind'],
    bpPolicy: row.bp_policy as BpPolicy,
    mapSource: isMapSource(row.map_source) ? row.map_source : 'pool',
    mapPoolId: row.map_pool_id,
    status: row.status as WipePlanStatus,
    absorbedBy: row.absorbed_by,
    generatedFor: row.generated_for,
    pinned: row.pinned === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
