// ============================================================
//  wipe-plans.test.ts  -  a agenda MATERIALIZADA, e a
//  reconciliação que não atropela humano.
//
//  O que este arquivo guarda:
//
//    1. a agenda sai na ordem, com forçado e cadência juntos e o
//       absorvido MARCADO (e não sumido);
//    2. adiar um wipe à mão sobrevive à reconciliação — e não vira
//       DOIS wipes, que é o que aconteceria sem `generated_for`;
//    3. trocar a cadência reescreve o que foi gerado e preserva o
//       que foi editado;
//    4. o forçado não pode ser pulado: 409 com explicação, e não
//       um 204 silencioso;
//    5. pular um wipe da cadência não o apaga — ele fica marcado,
//       senão a reconciliação seguinte o recriaria;
//    6. o passado é intocável, e apagar o servidor leva a agenda
//       dele junto.
//
//  O relógio é sempre um PARÂMETRO (`now`): nada aqui depende do
//  relógio da máquina, e é por isso que os testes falam de agosto
//  de 2026 sem nenhum timer.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerWipeRoutes } from '../src/http/routes/wipe.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import type { WipePlan, WipeSettings } from '../src/types/wipe.js';
import { forcedWipeOfMonth, zonedTimeToUtc } from '../src/wipe/schedule.js';

const SERVER = 'server01';
const OUTRO = 'pve01';
const SAO_PAULO = 'America/Sao_Paulo';

/** Terça, 18 de agosto de 2026, meio-dia UTC. */
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

const FORCADO_SETEMBRO = forcedWipeOfMonth(2026, 8);

/** 16:00 de tal dia de agosto/setembro em São Paulo, em epoch ms. */
function emSaoPaulo(month: number, day: number): number {
  return zonedTimeToUtc({ year: 2026, month, day }, 16, 0, SAO_PAULO);
}

/**
 * A cadência ligada, com o marco zero ao meio-dia UTC.
 *
 * Meio-dia de propósito: do marco zero só o DIA importa, e ele é
 * lido no fuso da cadência — meia-noite UTC seria a véspera em São
 * Paulo, e o teste falaria de uma semana que não é a que ele diz.
 */
function cadencia(patch: {
  readonly everyDays?: number;
  readonly anchorDay?: number;
  readonly policy?: WipeSettings['collision']['policy'];
  readonly windowHours?: number;
  readonly bpPolicy?: WipeSettings['cadence']['bpPolicy'];
}): WipeSettings {
  return {
    cadence: {
      enabled: true,
      everyDays: patch.everyDays ?? 7,
      anchorAt: Date.UTC(2026, 7, patch.anchorDay ?? 15, 12, 0, 0),
      timeOfDay: '16:00',
      timeZone: SAO_PAULO,
      bpPolicy: patch.bpPolicy ?? 'keep',
    },
    forced: { bpPolicy: 'keep' },
    collision: { policy: patch.policy ?? 'reanchor', windowHours: patch.windowHours ?? 24 },
  };
}

let db: AgentDatabase;
let repository: WipeScheduleRepository;

/** Um servidor espelhado na tabela, como o supervisor faria. */
function insertServer(id: string, ports: number): void {
  db.prepare(
    `INSERT INTO servers
       (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
        rcon_host, rcon_password, install_dir, created_at, updated_at)
     VALUES
       (@id, @id, @id, 1, @game, @rcon, @query, @app,
        '127.0.0.1', NULL, 'F:\\Servers\\' || @id, @now, @now)`,
  ).run({
    id,
    game: ports,
    rcon: ports + 1,
    query: ports + 2,
    app: ports + 3,
    now: NOW,
  });
}

beforeEach(() => {
  db = openDatabase({ file: MEMORY_DATABASE });
  runMigrations(db);
  insertServer(SERVER, 28015);
  insertServer(OUTRO, 28115);
  repository = new WipeScheduleRepository(db);
});

afterEach(() => {
  db.close();
});

/** Os planos futuros, na ordem. */
function agenda(serverId = SERVER): readonly WipePlan[] {
  return repository.listPlans(serverId, { from: NOW });
}

function planAt(instant: number, serverId = SERVER): WipePlan | undefined {
  return agenda(serverId).find((plan) => plan.scheduledAt === instant);
}

// ============================================================
//  1 — a configuração
// ============================================================

describe('a configuração da agenda', () => {
  it('nasce com a cadência DESLIGADA', () => {
    const settings = repository.getSettings(SERVER);

    // Um agente recém-instalado não tem opinião sobre quando zerar
    // o servidor de ninguém.
    expect(settings.cadence.enabled).toBe(false);
    expect(settings.forced.bpPolicy).toBe('keep');
    expect(settings.collision.policy).toBe('reanchor');
  });

  it('é por servidor: mexer num não mexe no outro', () => {
    repository.saveSettings(SERVER, cadencia({ everyDays: 3 }), NOW);

    expect(repository.getSettings(SERVER).cadence.everyDays).toBe(3);
    expect(repository.getSettings(OUTRO).cadence.enabled).toBe(false);
  });

  it('valor corrompido no banco cai no padrão DAQUELA chave', () => {
    repository.saveSettings(SERVER, cadencia({ everyDays: 3 }), NOW);

    db.prepare(
      `UPDATE wipe_settings SET value = 'muitos'
        WHERE server_id = @server AND key = 'cadence.everyDays'`,
    ).run({ server: SERVER });

    const settings = repository.getSettings(SERVER);

    // A chave quebrada volta ao padrão; as outras nove continuam
    // valendo. Lançar aqui faria uma linha digitada à mão no SQLite
    // derrubar o boot do agente inteiro.
    expect(settings.cadence.everyDays).toBe(7);
    expect(settings.cadence.enabled).toBe(true);
    expect(settings.cadence.timeZone).toBe(SAO_PAULO);
  });
});

// ============================================================
//  2 — a materialização
// ============================================================

describe('a agenda materializada', () => {
  it('com a cadência desligada, materializa só os forçados', () => {
    const result = repository.reconcile(SERVER, NOW);
    const plans = agenda();

    expect(result.created).toBe(plans.length);
    expect(plans.every((plan) => plan.kind === 'forced')).toBe(true);
    expect(plans[0]?.scheduledAt).toBe(FORCADO_SETEMBRO);
    // Gerada, e não fixada por humano — é o que a reconciliação
    // seguinte pode reescrever.
    expect(plans[0]?.pinned).toBe(false);
    expect(plans[0]?.generatedFor).toBe(FORCADO_SETEMBRO);
    expect(plans[0]?.mapSource).toBe('pool');
  });

  it('lista forçado e cadência juntos, na ordem em que acontecem', () => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);

    const plans = agenda();
    const kinds = new Set(plans.map((plan) => plan.kind));

    expect(kinds).toEqual(new Set(['forced', 'cadence']));
    expect(planAt(emSaoPaulo(8, 22))?.kind).toBe('cadence');
    expect(planAt(FORCADO_SETEMBRO)?.kind).toBe('forced');

    for (const [index, plan] of plans.entries()) {
      if (index > 0) {
        expect(plan.scheduledAt).toBeGreaterThan(plans[index - 1]!.scheduledAt);
      }
    }
  });

  it('rodar duas vezes seguidas não cria nada de novo', () => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);

    const antes = agenda().map((plan) => plan.id);

    expect(repository.reconcile(SERVER, NOW)).toEqual({ created: 0, updated: 0, removed: 0 });
    // E os ids não mudam: o painel que está com a tela aberta
    // continua mandando PATCH para linhas que existem.
    expect(agenda().map((plan) => plan.id)).toEqual(antes);
  });

  it('o absorvido fica na lista, marcado, e apontando para o forçado', () => {
    repository.saveSettings(SERVER, cadencia({ anchorDay: 19, policy: 'absorb' }), NOW);
    repository.reconcile(SERVER, NOW);

    const vespera = planAt(emSaoPaulo(9, 2));
    const forcado = planAt(FORCADO_SETEMBRO);

    expect(vespera?.status).toBe('absorbed');
    // A coluna guarda o ID da linha do forçado, e não o instante:
    // é o que permite a tela dizer "cancelado por ESTE wipe".
    expect(vespera?.absorbedBy).toBe(forcado?.id);
    expect(vespera?.note).toContain('Cancelado');

    // E o próximo de verdade pula o absorvido.
    expect(repository.nextPlan(SERVER, vespera!.scheduledAt - 3_600_000)?.id).toBe(forcado?.id);

    // A segunda volta não mexe em nada: a tradução do instante
    // absorvido para o ID da linha é idempotente.
    expect(repository.reconcile(SERVER, NOW)).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('a agenda de um servidor não aparece na do outro', () => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);

    expect(agenda().length).toBeGreaterThan(0);
    expect(agenda(OUTRO)).toEqual([]);
  });
});

// ============================================================
//  3 — adiar, e a reconciliação que não desfaz
// ============================================================

describe('adiar um wipe à mão', () => {
  beforeEach(() => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);
  });

  it('fixa a linha e guarda de onde ela saiu', () => {
    const original = planAt(emSaoPaulo(8, 22));
    const adiado = repository.updatePlan(
      SERVER,
      original!.id,
      { scheduledAt: emSaoPaulo(8, 23) },
      NOW,
    );

    expect(adiado.scheduledAt).toBe(emSaoPaulo(8, 23));
    // Editar é FIXAR: sem isso a reconciliação devolveria o wipe
    // para sábado sem ninguém ter mexido.
    expect(adiado.pinned).toBe(true);
    expect(adiado.generatedFor).toBe(emSaoPaulo(8, 22));
  });

  it('e a reconciliação NÃO cria um segundo wipe na data original', () => {
    const original = planAt(emSaoPaulo(8, 22));

    repository.updatePlan(SERVER, original!.id, { scheduledAt: emSaoPaulo(8, 23) }, NOW);
    repository.reconcile(SERVER, NOW);

    // O buraco de sábado NÃO é preenchido: é `generated_for` que
    // conta essa história para a reconciliação.
    expect(planAt(emSaoPaulo(8, 22))).toBeUndefined();
    expect(planAt(emSaoPaulo(8, 23))?.id).toBe(original!.id);
  });

  it('trocar a cadência reescreve o gerado e preserva o adiado', () => {
    const original = planAt(emSaoPaulo(8, 22));

    repository.updatePlan(SERVER, original!.id, { scheduledAt: emSaoPaulo(8, 23) }, NOW);

    repository.saveSettings(SERVER, cadencia({ everyDays: 3 }), NOW);
    repository.reconcile(SERVER, NOW);

    // O que era de 7 em 7 dias virou de 3 em 3…
    expect(planAt(emSaoPaulo(8, 21))?.kind).toBe('cadence');
    expect(planAt(emSaoPaulo(8, 24))?.kind).toBe('cadence');
    expect(planAt(emSaoPaulo(8, 29))).toBeUndefined();

    // …e o adiado à mão continua onde o humano o pôs.
    const preservado = planAt(emSaoPaulo(8, 23));

    expect(preservado?.id).toBe(original!.id);
    expect(preservado?.pinned).toBe(true);
  });

  it('a data do FORÇADO não se muda — a política de BP dele, sim', () => {
    const forcado = planAt(FORCADO_SETEMBRO);

    try {
      repository.updatePlan(
        SERVER,
        forcado!.id,
        { scheduledAt: FORCADO_SETEMBRO + 3_600_000 },
        NOW,
      );
      expect.unreachable('mover a data do forçado devia ter sido recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('WIPE_FORCED_DATE_IS_FIXED');
      expect(isApiError(error) && error.status).toBe(409);
    }

    const comBpTrocado = repository.updatePlan(SERVER, forcado!.id, { bpPolicy: 'wipe' }, NOW);

    expect(comBpTrocado.bpPolicy).toBe('wipe');
    expect(comBpTrocado.scheduledAt).toBe(FORCADO_SETEMBRO);
  });

  it('não deixa dois wipes no mesmo instante', () => {
    const original = planAt(emSaoPaulo(8, 22));

    try {
      repository.updatePlan(SERVER, original!.id, { scheduledAt: FORCADO_SETEMBRO }, NOW);
      expect.unreachable('dois wipes no mesmo instante deviam ter sido recusados');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('WIPE_SCHEDULE_CONFLICT');
    }
  });
});

// ============================================================
//  4 e 5 — pular
// ============================================================

describe('pular um wipe', () => {
  beforeEach(() => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);
  });

  it('o FORÇADO recusa, com explicação — e continua na agenda', () => {
    const forcado = planAt(FORCADO_SETEMBRO);

    try {
      repository.skipPlan(SERVER, forcado!.id, NOW);
      expect.unreachable('pular o forçado devia ter sido recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('WIPE_FORCED_CANNOT_BE_SKIPPED');
      expect(isApiError(error) && error.status).toBe(409);
      // A frase diz POR QUE, e não só que não deu.
      expect(isApiError(error) && error.message).toContain('acontece com ou sem o agente');
    }

    expect(planAt(FORCADO_SETEMBRO)?.status).toBe('planned');
  });

  it('o da cadência fica na lista, marcado — e não volta na reconciliação', () => {
    const alvo = planAt(emSaoPaulo(8, 22));
    const pulado = repository.skipPlan(SERVER, alvo!.id, NOW);

    expect(pulado?.status).toBe('skipped');

    repository.reconcile(SERVER, NOW);

    // Apagar a linha faria a reconciliação recriá-la no mesmo
    // instante: o wipe "pulado" voltaria sozinho.
    expect(planAt(emSaoPaulo(8, 22))?.status).toBe('skipped');
    expect(agenda().filter((plan) => plan.scheduledAt === emSaoPaulo(8, 22))).toHaveLength(1);
  });

  it('o que foi marcado à mão some de verdade', () => {
    const manual = repository.createPlan(
      SERVER,
      { scheduledAt: emSaoPaulo(8, 25), bpPolicy: 'wipe', note: 'evento' },
      NOW,
    );

    expect(repository.skipPlan(SERVER, manual.id, NOW)).toBeNull();
    expect(repository.getPlan(SERVER, manual.id)).toBeNull();
  });

  it('um wipe que já rodou não se edita nem se pula', () => {
    const alvo = planAt(emSaoPaulo(8, 22));

    db.prepare('UPDATE wipe_plans SET status = @status WHERE id = @id').run({
      status: 'done',
      id: alvo!.id,
    });

    for (const acao of [
      (): unknown => repository.updatePlan(SERVER, alvo!.id, { bpPolicy: 'wipe' }, NOW),
      (): unknown => repository.skipPlan(SERVER, alvo!.id, NOW),
    ]) {
      try {
        acao();
        expect.unreachable('editar um wipe consumado devia ter sido recusado');
      } catch (error) {
        expect(isApiError(error) && error.code).toBe('WIPE_PLAN_NOT_EDITABLE');
      }
    }
  });
});

// ============================================================
//  6 — o wipe à mão, o passado, e o servidor apagado
// ============================================================

describe('o wipe marcado à mão', () => {
  it('nasce manual e fixado, e sobrevive à reconciliação', () => {
    const manual = repository.createPlan(
      SERVER,
      { scheduledAt: emSaoPaulo(8, 25), bpPolicy: 'wipe_except_vip' },
      NOW,
    );

    expect(manual.kind).toBe('manual');
    expect(manual.pinned).toBe(true);
    expect(manual.generatedFor).toBeNull();

    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);

    expect(repository.getPlan(SERVER, manual.id)?.bpPolicy).toBe('wipe_except_vip');
  });

  it('recusa o passado e o instante já ocupado', () => {
    try {
      repository.createPlan(SERVER, { scheduledAt: NOW - 1000, bpPolicy: 'keep' }, NOW);
      expect.unreachable('agendar no passado devia ter sido recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('WIPE_SCHEDULE_IN_THE_PAST');
      expect(isApiError(error) && error.status).toBe(400);
    }

    repository.createPlan(SERVER, { scheduledAt: emSaoPaulo(8, 25), bpPolicy: 'keep' }, NOW);

    try {
      repository.createPlan(SERVER, { scheduledAt: emSaoPaulo(8, 25), bpPolicy: 'keep' }, NOW);
      expect.unreachable('dois wipes no mesmo instante deviam ter sido recusados');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('WIPE_SCHEDULE_CONFLICT');
    }
  });
});

describe('a reconciliação e o passado', () => {
  it('não toca no que já passou', () => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);

    const antigo = planAt(emSaoPaulo(8, 22));

    // Uma semana depois, aquele wipe já é passado.
    const depois = NOW + 14 * 86_400_000;

    repository.reconcile(SERVER, depois);

    const ainda = repository.getPlan(SERVER, antigo!.id);

    expect(ainda?.scheduledAt).toBe(emSaoPaulo(8, 22));
    expect(ainda?.status).toBe('planned');
    // E a agenda continua materializada à frente do novo "agora".
    expect(repository.listPlans(SERVER, { from: depois }).length).toBeGreaterThan(5);
  });

  it('apagar o servidor leva a agenda e a configuração dele', () => {
    repository.saveSettings(SERVER, cadencia({}), NOW);
    repository.reconcile(SERVER, NOW);
    repository.reconcile(OUTRO, NOW);

    db.prepare('DELETE FROM servers WHERE id = @id').run({ id: SERVER });

    expect(agenda()).toEqual([]);
    expect(
      db.prepare('SELECT count(*) AS total FROM wipe_settings WHERE server_id = @id').get({
        id: SERVER,
      }),
    ).toEqual({ total: 0 });
    // O outro servidor não sentiu nada.
    expect(agenda(OUTRO).length).toBeGreaterThan(0);
  });
});

// ============================================================
//  7 — as rotas
// ============================================================

/**
 * Um Fastify com as rotas de wipe e o tradutor de erro.
 *
 * Em produção quem registra o `setErrorHandler` é o `buildServer`.
 * Aqui ele é repetido porque o que se testa é justamente o CÓDIGO
 * do erro (`WIPE_FORCED_CANNOT_BE_SKIPPED`) — sem o handler, o
 * Fastify responderia o genérico dele.
 */
function makeApp(): FastifyInstance {
  const app = Fastify();

  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    throw error;
  });

  registerWipeRoutes(app, {
    repository,
    // O supervisor entra só para responder "este servidor existe?".
    supervisor: { ids: (): readonly string[] => [SERVER, OUTRO] } as unknown as ServerSupervisor,
  });

  return app;
}

/**
 * O corpo de configuração que a tela manda.
 *
 * Ele é exatamente o `WipeSettings` do contrato (types/wipe.ts) —
 * e é assim que o teste guarda que a rota não pede um campo a
 * mais nem aceita um a menos.
 */
function settingsBody(everyDays: number): WipeSettings {
  return {
    cadence: {
      enabled: true,
      everyDays,
      anchorAt: Date.now(),
      timeOfDay: '16:00',
      timeZone: SAO_PAULO,
      bpPolicy: 'keep',
    },
    forced: { bpPolicy: 'keep' },
    collision: { policy: 'reanchor', windowHours: 24 },
  };
}

describe('as rotas da agenda', () => {
  it('PUT /wipe/settings grava, reconcilia e devolve a agenda nova', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/wipe/settings`,
      payload: settingsBody(7),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      ok: boolean;
      plans: WipePlan[];
      now: number;
      nextForcedAt: number;
      next: WipePlan | null;
      reconciled: { created: number };
    };

    expect(body.ok).toBe(true);
    expect(body.reconciled.created).toBeGreaterThan(0);
    // A tela desenha a agenda nova sem uma segunda requisição.
    expect(body.plans.length).toBeGreaterThan(0);
    // E o relógio do AGENTE vai junto, para a contagem regressiva.
    expect(body.nextForcedAt).toBeGreaterThan(body.now);
    expect(body.next?.scheduledAt).toBeGreaterThan(body.now);

    await app.close();
  });

  it('GET /wipe/plans lista forçado e cadência na ordem', async () => {
    const app = makeApp();

    await app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/wipe/settings`,
      payload: settingsBody(7),
    });

    const response = await app.inject({ method: 'GET', url: `/servers/${SERVER}/wipe/plans` });
    const body = response.json() as { count: number; plans: WipePlan[] };

    expect(response.statusCode).toBe(200);
    expect(body.count).toBe(body.plans.length);
    expect(body.plans.some((plan) => plan.kind === 'forced')).toBe(true);
    expect(body.plans.some((plan) => plan.kind === 'cadence')).toBe(true);

    for (const [index, plan] of body.plans.entries()) {
      if (index > 0) {
        expect(plan.scheduledAt).toBeGreaterThan(body.plans[index - 1]!.scheduledAt);
      }
    }

    await app.close();
  });

  it('DELETE num plano forçado responde 409 com explicação', async () => {
    const app = makeApp();

    await app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/wipe/settings`,
      payload: settingsBody(7),
    });

    const plans = (
      (
        await app.inject({ method: 'GET', url: `/servers/${SERVER}/wipe/plans` })
      ).json() as { plans: WipePlan[] }
    ).plans;

    const forcado = plans.find((plan) => plan.kind === 'forced');
    const response = await app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/wipe/plans/${String(forcado?.id)}`,
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('WIPE_FORCED_CANNOT_BE_SKIPPED');

    await app.close();
  });

  it('GET /wipe/upcoming responde mesmo sem agenda materializada', async () => {
    const app = makeApp();

    const response = await app.inject({ method: 'GET', url: `/servers/${SERVER}/wipe/upcoming` });
    const body = response.json() as { plans: WipePlan[]; nextForcedAt: number; now: number };

    expect(response.statusCode).toBe(200);
    // A tela abre com a agenda vazia sem quebrar — e o forçado, que
    // é derivado, aparece de qualquer jeito.
    expect(body.plans).toEqual([]);
    expect(body.nextForcedAt).toBeGreaterThan(body.now);

    await app.close();
  });

  it('recusa fuso desconhecido, servidor desconhecido e data no passado', async () => {
    const app = makeApp();

    const fuso = await app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/wipe/settings`,
      payload: {
        ...settingsBody(7),
        cadence: {
          enabled: true,
          everyDays: 7,
          anchorAt: Date.now(),
          timeOfDay: '16:00',
          timeZone: 'America/Nao_Existe',
          bpPolicy: 'keep',
        },
      },
    });

    expect(fuso.statusCode).toBe(400);
    expect((fuso.json() as { error: string }).error).toBe('INVALID_BODY');

    const desconhecido = await app.inject({ method: 'GET', url: '/servers/naoexiste/wipe/plans' });

    expect(desconhecido.statusCode).toBe(404);
    expect((desconhecido.json() as { error: string }).error).toBe('UNKNOWN_SERVER');

    const passado = await app.inject({
      method: 'POST',
      url: `/servers/${SERVER}/wipe/plans`,
      payload: { scheduledAt: Date.now() - 86_400_000, bpPolicy: 'keep' },
    });

    expect(passado.statusCode).toBe(400);
    expect((passado.json() as { error: string }).error).toBe('WIPE_SCHEDULE_IN_THE_PAST');

    await app.close();
  });

  it('POST cria o wipe manual, e PATCH adia o da cadência', async () => {
    const app = microAgenda();

    const daquiA10Dias = Date.now() + 10 * 86_400_000;

    const criado = await app.inject({
      method: 'POST',
      url: `/servers/${SERVER}/wipe/plans`,
      payload: { scheduledAt: daquiA10Dias, bpPolicy: 'wipe', note: 'evento de aniversário' },
    });

    expect(criado.statusCode).toBe(201);

    const plan = (criado.json() as { plan: WipePlan }).plan;

    expect(plan.kind).toBe('manual');
    expect(plan.pinned).toBe(true);

    const adiado = await app.inject({
      method: 'PATCH',
      url: `/servers/${SERVER}/wipe/plans/${String(plan.id)}`,
      payload: { scheduledAt: daquiA10Dias + 86_400_000 },
    });

    expect(adiado.statusCode).toBe(200);
    expect((adiado.json() as { plan: WipePlan }).plan.scheduledAt).toBe(
      daquiA10Dias + 86_400_000,
    );

    // PATCH vazio é recusado: pinar uma linha em silêncio seria uma
    // surpresa na próxima reconciliação.
    const vazio = await app.inject({
      method: 'PATCH',
      url: `/servers/${SERVER}/wipe/plans/${String(plan.id)}`,
      payload: {},
    });

    expect(vazio.statusCode).toBe(400);

    await app.close();
  });
});

/** Um app com a agenda já materializada pelo relógio de verdade. */
function microAgenda(): FastifyInstance {
  const app = makeApp();

  repository.reconcile(SERVER);

  return app;
}
