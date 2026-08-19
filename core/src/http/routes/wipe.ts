// ============================================================
//  routes/wipe.ts  -  A AGENDA DO WIPE, por servidor.
//
//      GET    /servers/:id/wipe/settings
//      PUT    /servers/:id/wipe/settings
//      GET    /servers/:id/wipe/plans?from=&to=
//      POST   /servers/:id/wipe/plans            um wipe à mão
//      PATCH  /servers/:id/wipe/plans/:planId    adiar, política
//      DELETE /servers/:id/wipe/plans/:planId    pular
//      GET    /servers/:id/wipe/upcoming         o que vem por aí
//
//  ####  NADA AQUI EXECUTA NADA  ####
//
//  Nenhuma destas rotas para servidor, apaga arquivo ou manda
//  RCON: elas dizem QUANDO o wipe é e o QUE ele leva. Executar é
//  `POST /wipe/runs`, da Frente D — uma operação, com trava, log e
//  passos retomáveis, e não um verbo escondido numa rota de
//  configuração.
//
//  ------------------------------------------------------------
//  ####  GRAVAR A CONFIGURAÇÃO RECONCILIA NA MESMA RESPOSTA  ####
//
//  Um PUT em `/settings` que só gravasse deixaria a agenda
//  desatualizada até alguém reiniciar o agente: a tela mostraria a
//  cadência nova ao lado das datas antigas, e o admin não teria
//  como saber qual das duas o agente vai obedecer.
//
//  Então o PUT grava, reconcilia e devolve a agenda recalculada —
//  o que a tela precisa desenhar já vem na resposta do próprio
//  salvamento.
//
//  ------------------------------------------------------------
//  ####  TODA RESPOSTA TRAZ `now`  ####
//
//  É o relógio DO AGENTE. A contagem regressiva da tela sai dele,
//  corrigida pela diferença para o relógio local: um navegador
//  adiantado em dez minutos mostraria "faltam 3 min" para um wipe
//  que ainda tem uma hora.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  DEFAULT_WIPE_HORIZON_DAYS,
  type WipeScheduleRepository,
} from '../../db/wipe-schedule-repository.js';
import {
  buildPlayerCalendar,
  type CalendarMapQueueReader,
  type CalendarVipReader,
} from '../../game/ui-calendar-screen.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { BP_POLICIES, COLLISION_POLICIES, MAP_SOURCES } from '../../types/wipe.js';
import { readVipTiers } from '../../vip/tiers.js';
import { nextWipe, type WipeRunsReader } from '../../wipe/next-wipe.js';
import { isValidTimeZone, nextForcedWipe } from '../../wipe/schedule.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WipeRoutesDeps {
  readonly repository: WipeScheduleRepository;
  readonly supervisor: ServerSupervisor;
  /**
   * A fila de mapas, para o `/upcoming/me`. Ausente = sem mundo a
   * mostrar, e a resposta sai com a lista vazia em vez de um 500.
   */
  readonly mapPool?: CalendarMapQueueReader;
  /** Quem tem VIP, para o recorte do `/upcoming/me`. */
  readonly vips?: CalendarVipReader;
  /**
   * As execuções em curso, para o `/upcoming/me`.
   *
   * ####  ELA É PARTE DA RESPOSTA, E NÃO UM ENFEITE  ####
   *
   * O "WIPAR AGORA com hora marcada" não tem plano nenhum: quem
   * sabe dele é `wipe_runs`. E nas horas que antecedem a hora
   * marcada o plano está `running`, não `planned`. Sem este leitor,
   * a rota do jogador responde uma coisa e o `{wipe.faltam}` do
   * chat responde outra — que é a divergência que a Frente G existe
   * para não ter.
   *
   * Ausente = a resposta cai só na agenda, e o servidor sobe do
   * mesmo jeito. Quem a liga é http/server.ts.
   */
  readonly runs?: WipeRunsReader;
}

/**
 * O que `nextWipe` lê quando a rota não recebeu tudo.
 *
 * Ausente é DIFERENTE de vazio só no nome: aqui "não sei" e "não
 * tem" dão a mesma resposta, e ela nunca é um 500 na cara de um
 * jogador que só queria saber quando é o wipe.
 */
const NOTHING_RUNNING: WipeRunsReader = { running: () => [] };
const NO_MAP_POOL: CalendarMapQueueReader = {
  list: () => [],
  next: () => null,
  get: () => null,
};

/** Quantos wipes o `/upcoming` devolve por padrão. */
export const DEFAULT_UPCOMING_LIMIT = 10;
export const MAX_UPCOMING_LIMIT = 50;

const serverParams = z.object({ id: z.string().min(1) });
const planParams = serverParams.extend({ planId: z.coerce.number().int().positive() });

const plansQuery = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});

const upcomingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_UPCOMING_LIMIT).optional(),
});

/**
 * O `/upcoming/me`: o mesmo teto, mais QUEM está perguntando.
 *
 * O SteamID é string em toda parte deste projeto — 17 dígitos
 * passam de 2^53, e convertido para número ele volta arredondado
 * (ver db/vips-repository.ts). Ausente = a resposta de quem não
 * tem VIP.
 */
const upcomingMeQuery = z.object({
  steamId: z.string().trim().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_UPCOMING_LIMIT).optional(),
});

/**
 * O fuso é conferido contra o runtime, e não contra uma lista.
 *
 * A base de zonas do ICU muda com a versão do Node; uma lista
 * nossa envelheceria e passaria a recusar zona que o próprio
 * agente sabe calcular.
 */
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'fuso desconhecido — use um nome IANA, como America/Sao_Paulo');

const timeOfDaySchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'o horário é HH:MM em 24 h — por exemplo, 16:00');

const settingsBody = z
  .object({
    cadence: z
      .object({
        enabled: z.boolean(),
        /**
         * Teto de um ano: acima disso não é cadência, é um wipe
         * marcado à mão — e para esse existe `POST /wipe/plans`.
         */
        everyDays: z.number().int().min(1).max(365),
        /** Epoch ms. Só o DIA importa; a hora vem de `timeOfDay`. */
        anchorAt: z.number().int().min(0),
        timeOfDay: timeOfDaySchema,
        timeZone: timeZoneSchema,
        bpPolicy: z.enum(BP_POLICIES),
      })
      .strict(),
    forced: z
      .object({
        // Sem `enabled`: o forçado acontece com ou sem nós. A única
        // escolha é o que ele leva.
        bpPolicy: z.enum(BP_POLICIES),
      })
      .strict(),
    collision: z
      .object({
        policy: z.enum(COLLISION_POLICIES),
        /** A janela do `absorb`, em horas. Ignorada nas outras duas. */
        windowHours: z.number().int().min(0).max(168),
      })
      .strict(),
  })
  .strict();

const noteSchema = z.string().trim().max(200).nullable();

const planBody = z
  .object({
    /** Epoch ms UTC. Ver o cabeçalho de types/wipe.ts. */
    scheduledAt: z.number().int().positive(),
    bpPolicy: z.enum(BP_POLICIES),
    mapSource: z.enum(MAP_SOURCES).default('pool'),
    /**
     * A entrada da fila de mapas (Frente C). `null` = decidir na
     * hora — e é o repositório que recusa `fixed` sem ela, porque
     * lá o estado FINAL da linha é conhecido e aqui não: um PATCH
     * pode mandar só `mapSource` para um plano que já aponta.
     */
    mapPoolId: z.number().int().positive().nullable().default(null),
    note: noteSchema.default(null),
  })
  .strict();

const planPatch = z
  .object({
    scheduledAt: z.number().int().positive().optional(),
    bpPolicy: z.enum(BP_POLICIES).optional(),
    mapSource: z.enum(MAP_SOURCES).optional(),
    mapPoolId: z.number().int().positive().nullable().optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    'diga o que muda: scheduledAt, bpPolicy, mapSource, mapPoolId ou note',
  );

export function registerWipeRoutes(app: FastifyInstance, deps: WipeRoutesDeps): void {
  /**
   * O bloco que toda resposta de agenda carrega.
   *
   * `nextForcedAt` vai junto do `next` lido da tabela, e os dois
   * podem divergir: o próximo wipe pode ser um da cadência, três
   * semanas antes do forçado. A tela precisa dos dois números para
   * dizer "próximo wipe em 3 dias — e o forçado, em 26".
   *
   * O forçado sai do CÁLCULO, e não da tabela: assim ele aparece
   * mesmo num servidor cuja agenda nunca foi materializada.
   */
  const summaryOf = (serverId: string, now: number) => ({
    now,
    nextForcedAt: nextForcedWipe(now),
    next: deps.repository.nextPlan(serverId, now),
  });

  // ==========================================================
  //  A configuração
  // ==========================================================

  app.get('/servers/:id/wipe/settings', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const now = Date.now();

    return {
      ok: true,
      settings: deps.repository.getSettings(id),
      ...summaryOf(id, now),
    };
  });

  /**
   * Grava a configuração INTEIRA e materializa a agenda.
   *
   * PUT, e não PATCH: a tela edita a cadência num formulário só e
   * manda tudo. Um merge parcial abriria a pergunta "o que
   * acontece com o que não veio?", e a única resposta segura seria
   * não mexer — o oposto do que espera quem desligou a cadência.
   */
  app.put('/servers/:id/wipe/settings', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = settingsBody.parse(request.body);

    assertServer(deps, id);

    const now = Date.now();
    const settings = deps.repository.saveSettings(id, body, now);
    const reconciled = deps.repository.reconcile(id, now, DEFAULT_WIPE_HORIZON_DAYS);

    request.log.info(
      {
        server: id,
        cadence: settings.cadence.enabled ? settings.cadence.everyDays : null,
        collision: settings.collision.policy,
        ...reconciled,
        by: operatorOf(request),
      },
      'agenda de wipe gravada e reconciliada',
    );

    return {
      ok: true,
      settings,
      reconciled,
      plans: deps.repository.listPlans(id, { from: now }),
      ...summaryOf(id, now),
      message: settings.cadence.enabled
        ? `Cadência de ${String(settings.cadence.everyDays)} dia(s) às ` +
          `${settings.cadence.timeOfDay} (${settings.cadence.timeZone}). A agenda foi recalculada.`
        : 'Cadência desligada: só o wipe forçado da Facepunch fica na agenda.',
    };
  });

  // ==========================================================
  //  A agenda
  // ==========================================================

  /**
   * A agenda materializada.
   *
   * Sem `from`, ela começa AGORA. O passado é um pedido explícito —
   * e é o que a grade do calendário faz ao abrir um mês que já
   * aconteceu.
   */
  app.get('/servers/:id/wipe/plans', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { from, to } = plansQuery.parse(request.query);

    assertServer(deps, id);

    const now = Date.now();

    const plans = deps.repository.listPlans(id, {
      from: from ?? now,
      ...(to === undefined ? {} : { to }),
    });

    return {
      ok: true,
      count: plans.length,
      plans,
      ...summaryOf(id, now),
    };
  });

  /**
   * O que vem por aí, para quem só quer os próximos.
   *
   * É a mesma tabela do `/plans`, recortada: o cartão "PRÓXIMO
   * WIPE" da tela e o calendário dentro do jogo (Frente G) leem
   * daqui, e nenhum dos dois quer noventa dias de agenda.
   *
   * O absorvido vem junto, marcado. Uma lista com um buraco não
   * explica por que terça não vai ter wipe.
   */
  app.get('/servers/:id/wipe/upcoming', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { limit } = upcomingQuery.parse(request.query);

    assertServer(deps, id);

    const now = Date.now();
    const horizon = now + DEFAULT_WIPE_HORIZON_DAYS * 86_400_000;

    const plans = deps.repository
      .listPlans(id, { from: now, to: horizon })
      .filter((plan) => plan.status === 'planned' || plan.status === 'absorbed')
      .slice(0, limit ?? DEFAULT_UPCOMING_LIMIT);

    return {
      ok: true,
      count: plans.length,
      plans,
      settings: deps.repository.getSettings(id),
      ...summaryOf(id, now),
    };
  });

  /**
   * Marca um wipe à mão.
   *
   * Ele nasce `manual` e `pinned`: a reconciliação não o apaga, e
   * ele não é recalculado quando a cadência muda.
   */
  app.post('/servers/:id/wipe/plans', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const body = planBody.parse(request.body);

    assertServer(deps, id);

    const plan = deps.repository.createPlan(id, body, Date.now());

    request.log.info(
      { server: id, plan: plan.id, at: plan.scheduledAt, by: operatorOf(request) },
      'wipe manual agendado pelo painel',
    );

    return reply.status(201).send({
      ok: true,
      plan,
      message: `Wipe manual marcado para ${new Date(plan.scheduledAt).toISOString()}.`,
    });
  });

  /** Adiar, trocar a política de blueprint, escolher o mapa, anotar. */
  app.patch('/servers/:id/wipe/plans/:planId', async (request) => {
    const { id, planId } = planParams.parse(request.params);
    const patch = planPatch.parse(request.body);

    assertServer(deps, id);

    const plan = deps.repository.updatePlan(id, planId, patch, Date.now());

    request.log.info(
      { server: id, plan: plan.id, at: plan.scheduledAt, by: operatorOf(request) },
      'wipe agendado alterado pelo painel',
    );

    return {
      ok: true,
      plan,
      message:
        patch.scheduledAt === undefined
          ? 'Wipe alterado.'
          : `Wipe adiado para ${new Date(plan.scheduledAt).toISOString()}. Ele não é mais ` +
            'recalculado pela cadência.',
    };
  });

  /**
   * PULA este wipe.
   *
   * ####  O FORÇADO RECUSA, COM EXPLICAÇÃO  ####
   *
   * 409, e não um 204 silencioso: quem clicou precisa saber que
   * aquele wipe vai acontecer de qualquer jeito — o servidor não
   * sobe com o mundo antigo depois da atualização mensal.
   *
   * O wipe da cadência não some da lista: ele fica marcado como
   * `skipped`. Some de verdade só o que foi marcado à mão, porque
   * nada o recria.
   */
  app.delete('/servers/:id/wipe/plans/:planId', async (request) => {
    const { id, planId } = planParams.parse(request.params);

    assertServer(deps, id);

    const plan = deps.repository.skipPlan(id, planId, Date.now());

    request.log.warn(
      { server: id, plan: planId, removed: plan === null, by: operatorOf(request) },
      'wipe agendado pulado pelo painel',
    );

    return {
      ok: true,
      plan,
      message:
        plan === null
          ? 'O wipe marcado à mão foi removido da agenda.'
          : 'Este wipe não vai acontecer. Ele fica na agenda, marcado como pulado, para a tela ' +
            'poder explicar a semana sem wipe.',
    };
  });

  // ==========================================================
  //  O que UM JOGADOR pode ver do futuro
  // ==========================================================

  /**
   * A agenda RECORTADA pelo nível de VIP daquele jogador.
   *
   * ####  ELA NÃO É O `/upcoming` COM UM FILTRO NA TELA  ####
   *
   * O `/upcoming` acima é do painel: ele mostra tudo porque quem o
   * lê é quem administra. Esta responde à pergunta do JOGADOR, e a
   * régua do Docs\16 §9.3 vale aqui do mesmo jeito que vale na tela
   * do jogo:
   *
   *   sem VIP / bronze   a data e a política de blueprint
   *   silver             + o mapa do próximo wipe (sem a seed)
   *   gold               + os três próximos
   *
   * O corte acontece em `buildPlayerCalendar`, que é o MESMO que a
   * tela do jogo usa (game/ui-calendar-screen.ts). Dois recortes,
   * um por caminho, dariam duas respostas para a mesma pergunta — e
   * a que vaza seria descoberta por quem tem interesse em vazá-la.
   *
   * Sem `?steamId=`, a resposta é a de quem não tem VIP: negar por
   * falta de identidade é a saída conservadora.
   */
  app.get('/servers/:id/wipe/upcoming/me', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { steamId, limit } = upcomingMeQuery.parse(request.query);

    assertServer(deps, id);

    const now = Date.now();
    const settings = deps.repository.getSettings(id);

    const tiers =
      steamId === undefined || deps.vips === undefined
        ? []
        : deps.vips.activeOf(steamId, now).map((vip) => vip.tier);

    // A MESMA decisão do chat e da tela do jogo. Ver
    // wipe/next-wipe.ts: uma segunda conta aqui faria a rota do
    // jogador responder um wipe e o `{wipe.faltam}` responder outro.
    const next = nextWipe(
      id,
      {
        schedule: deps.repository,
        runs: deps.runs ?? NOTHING_RUNNING,
        mapPool: deps.mapPool ?? NO_MAP_POOL,
      },
      now,
    );

    const calendar = buildPlayerCalendar({
      now,
      timeZone: settings.cadence.timeZone,
      next,
      plans: deps.repository.listPlans(id, { from: now }),
      queue: deps.mapPool?.list(id) ?? [],
      tiers,
      // A hierarquia entre níveis é do `OrigemZVip.json` daquele
      // servidor. Sem VIP nenhum não há o que comparar, e ler o
      // arquivo seria ir ao disco para confirmar um zero.
      levels: tiers.length === 0 ? [] : await levelsOf(deps, id),
      ...(limit === undefined ? {} : { limit }),
    });

    return { ok: true, ...calendar, nextForcedAt: nextForcedWipe(now) };
  });
}

/**
 * Os níveis de VIP daquele servidor.
 *
 * Nunca lança: um `OrigemZVip.json` ausente ou quebrado não pode
 * derrubar a agenda do jogador — o pior que acontece é um nível
 * ainda não declarado não desbloquear o mapa. Mesma escolha do
 * `#levelsOf` dos kits.
 */
async function levelsOf(deps: WipeRoutesDeps, serverId: string) {
  const config = deps.supervisor.configOf(serverId);

  if (config === null) {
    return [];
  }

  return (await readVipTiers(config.paths.oxideConfigDir)).levels;
}

/**
 * @throws {ApiError} 404 quando o servidor não existe neste agente.
 *
 * Sem isto, a chave estrangeira de `wipe_plans` recusaria a
 * inserção com um 500 sem explicação.
 */
function assertServer(deps: WipeRoutesDeps, serverId: string): void {
  if (deps.supervisor.ids().includes(serverId)) {
    return;
  }

  throw new ApiError(
    'UNKNOWN_SERVER',
    `Não existe servidor com o id "${serverId}" neste agente. Os que existem: ` +
      `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
    404,
  );
}
