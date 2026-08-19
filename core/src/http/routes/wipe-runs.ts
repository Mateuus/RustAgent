// ============================================================
//  routes/wipe-runs.ts  -  A EXECUÇÃO. É a rota que apaga.
//
//      GET    /servers/:id/wipe/preview       o que vai apagar
//      GET    /servers/:id/wipe/plugin-data   o full wipe, do disco
//      GET    /servers/:id/wipe/exec-settings
//      PUT    /servers/:id/wipe/exec-settings
//      POST   /servers/:id/wipe/runs          WIPAR AGORA
//      GET    /servers/:id/wipe/runs          histórico
//      GET    /servers/:id/wipe/runs/:runId   passos + log
//      POST   /servers/:id/wipe/runs/:runId/resume
//      POST   /servers/:id/wipe/runs/:runId/cancel
//
//  ####  O POST EXIGE DUAS COISAS, E AS DUAS SÃO NECESSÁRIAS  ####
//
//    Idempotency-Key   um duplo-clique no painel não pode zerar o
//                      servidor duas vezes. A chave é gravada na
//                      linha, com índice único: a segunda chamada
//                      recebe a MESMA execução, e não uma nova.
//    identity no corpo o nome do servidor, DIGITADO. É a
//                      confirmação forte que o GitHub usa para
//                      apagar repositório, e o motivo é o mesmo:
//                      qualquer "tem certeza?" é vencido por um
//                      duplo-clique distraído.
//
//  ####  E AS RECUSAS ACONTECEM COM O SERVIDOR AINDA NO AR  ####
//
//  Disco cheio vira 409 aqui, ANTES do 202 — e não no passo
//  `backup`, que roda com o servidor já parado. Falhar ali é o
//  pior desfecho possível: os jogadores fora, o mundo intacto, e
//  uma operação que não dá para abandonar nem concluir.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ServerConfig } from '../../config.js';
import type { MapPoolRepository } from '../../db/map-pool-repository.js';
import {
  MAX_ANNOUNCE_OFFSETS,
  MAX_ANNOUNCE_OFFSET_MINUTES,
  type WipeExecSettings,
  type WipeRunsRepository,
} from '../../db/wipe-runs-repository.js';
import type { WipeScheduleRepository } from '../../db/wipe-schedule-repository.js';
import type { WipesRepository } from '../../db/wipes-repository.js';
import type { OperationStore } from '../../ops/operations.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { BP_POLICIES } from '../../types/wipe.js';
import { listPluginData } from '../../wipe/plugin-data.js';
import { buildWipePreview } from '../../wipe/preview.js';
import type { WipeWorldClock } from '../../wipe/run.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WipeRunRoutesDeps {
  readonly runs: WipeRunsRepository;
  readonly wipes: WipesRepository;
  readonly schedule: WipeScheduleRepository;
  readonly mapPool: MapPoolRepository;
  readonly supervisor: ServerSupervisor;
  readonly store: OperationStore;
  readonly world: WipeWorldClock;
}

const serverParams = z.object({ id: z.string().min(1) });
const runParams = serverParams.extend({ runId: z.coerce.number().int().positive() });
const logQuery = z.object({ fromLine: z.coerce.number().int().min(0).optional() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

const execSettingsSchema = z
  .object({
    announce: z.object({
      offsetsMinutes: z
        .array(z.number().int().min(1).max(MAX_ANNOUNCE_OFFSET_MINUTES))
        .max(MAX_ANNOUNCE_OFFSETS),
      text: z.string().min(1).max(512),
      tag: z.string().max(24),
      tagColor: z.string().max(16),
      color: z.string().max(16),
      size: z.number().int().min(8).max(40),
    }),
    drain: z.object({
      enabled: z.boolean(),
      waitMinutes: z.number().int().min(0).max(60),
      force: z.boolean(),
    }),
    backup: z.object({ enabled: z.boolean(), keep: z.number().int().min(1).max(30) }),
    pluginData: z.object({
      enabled: z.boolean(),
      // Cada padrão é um caminho relativo à pasta do servidor. O
      // teto existe para uma lista colada de fora não virar uma
      // varredura de disco por requisição.
      patterns: z.array(z.string().min(1).max(300)).max(200),
    }),
    post: z.object({
      resync: z.boolean(),
      announce: z.boolean(),
      announceText: z.string().max(512),
    }),
  })
  .strict();

const startSchema = z
  .object({
    /** O `SERVER_IDENTITY`, digitado. Ver o cabeçalho. */
    identity: z.string().min(1),
    /** O plano da agenda que este wipe consome. Ausente = WIPAR AGORA. */
    planId: z.number().int().positive().nullable().optional(),
    bpPolicy: z.enum(BP_POLICIES).optional(),
    fullWipe: z.boolean().optional(),
    /**
     * Quando o mundo zera. Ausente = agora.
     *
     * Com uma hora futura, o passo `avisar` cumpre os offsets antes
     * de qualquer coisa acontecer — é o "wipar daqui a 15 min" com
     * a contagem no chat.
     */
    at: z.number().int().min(0).optional(),
  })
  .strict();

export function registerWipeRunRoutes(app: FastifyInstance, deps: WipeRunRoutesDeps): void {
  // ----------------------------------------------------------
  //  O QUE VAI ACONTECER  (leitura pura)
  // ----------------------------------------------------------

  /**
   * A lista de arquivos, lida do disco, ANTES do botão.
   *
   * Ela não escreve nada, e por isso é segura de chamar a cada
   * abertura de tela — inclusive com o servidor no ar e cheio de
   * gente. Ver wipe/preview.ts.
   */
  app.get('/servers/:id/wipe/preview', async (request) => {
    const { id } = serverParams.parse(request.params);
    const config = assertServer(deps, id);
    const context = deps.supervisor.contextOf(id);

    const preview = await buildWipePreview({
      serverId: id,
      identity: config.identity,
      installDir: config.paths.installDir,
      backupsDir: config.paths.backupsDir,
      current: currentWorldOf(config),
      schedule: deps.schedule,
      // A execução em curso: nas 24 h que antecedem um wipe
      // agendado o plano dele já está `running`, e é ELE que esta
      // tela descreve. Sem isto ela volta a descrever o wipe da
      // semana que vem — outro mundo e outra política de blueprint.
      runs: deps.runs,
      mapPool: deps.mapPool,
      exec: deps.runs.getExecSettings(id),
      running: context === null ? null : await context.operations.isRunning(),
      rconConnected: context?.rcon.isConnected ?? false,
    });

    return { ok: true, ...preview };
  });

  /** O que existe DE VERDADE em disco, para o admin escolher. */
  app.get('/servers/:id/wipe/plugin-data', async (request) => {
    const { id } = serverParams.parse(request.params);
    const config = assertServer(deps, id);
    const exec = deps.runs.getExecSettings(id);

    const listing = await listPluginData({
      installDir: config.paths.installDir,
      identity: config.identity,
      selected: exec.pluginData.patterns,
      bpPolicy: deps.schedule.nextPlan(id)?.bpPolicy ?? 'keep',
    });

    return { ok: true, now: Date.now(), ...listing };
  });

  // ----------------------------------------------------------
  //  COMO O AGENTE EXECUTA
  // ----------------------------------------------------------

  app.get('/servers/:id/wipe/exec-settings', (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    return { ok: true, now: Date.now(), settings: deps.runs.getExecSettings(id) };
  });

  app.put('/servers/:id/wipe/exec-settings', (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const settings: WipeExecSettings = execSettingsSchema.parse(request.body);
    const saved = deps.runs.saveExecSettings(id, settings, Date.now());

    request.log.info(
      { server: id, by: operatorOf(request) },
      'configuração de execução do wipe alterada pelo painel',
    );

    return { ok: true, now: Date.now(), settings: saved, message: 'Configuração salva.' };
  });

  // ----------------------------------------------------------
  //  A EXECUÇÃO
  // ----------------------------------------------------------

  app.get('/servers/:id/wipe/runs', (request) => {
    const { id } = serverParams.parse(request.params);
    const { limit } = historyQuery.parse(request.query);

    assertServer(deps, id);

    return {
      ok: true,
      now: Date.now(),
      runs: deps.runs.list(id, limit ?? 20),
      worlds: deps.wipes.list(id, 10),
    };
  });

  /**
   * Uma execução, com os passos e o log a partir do cursor.
   *
   * O log é da OPERAÇÃO, que vive em memória: depois de um
   * `pm2 restart` ele some, e o que sobra são os passos, que estão
   * no banco. A resposta diz qual dos dois casos é (`live`), para a
   * tela não mostrar um console vazio como se fosse silêncio.
   */
  app.get('/servers/:id/wipe/runs/:runId', (request) => {
    const { id, runId } = runParams.parse(request.params);
    const { fromLine } = logQuery.parse(request.query);

    assertServer(deps, id);

    const run = deps.runs.get(id, runId);

    if (run === null) {
      throw new ApiError(
        'UNKNOWN_WIPE_RUN',
        `Não existe execução de wipe ${String(runId)} no servidor "${id}".`,
        404,
      );
    }

    const operation = run.operationId === null ? null : deps.store.get(run.operationId);
    const cursor = fromLine ?? 0;

    return {
      ok: true,
      now: Date.now(),
      run,
      live: operation !== null,
      operation: operation?.view() ?? null,
      lines:
        operation?.logFrom(cursor).map((line) => ({ n: line.n, at: line.at, text: line.text })) ??
        [],
      nextLine: operation?.nextLine ?? cursor,
      droppedLines: operation?.droppedLines ?? 0,
    };
  });

  /**
   * WIPAR AGORA. É a única rota do agente que apaga o trabalho de
   * todos os jogadores.
   */
  app.post('/servers/:id/wipe/runs', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const body = startSchema.parse(request.body);
    const config = assertServer(deps, id);

    // ---- 1. a chave ------------------------------------------
    const key = idempotencyKeyOf(request.headers['idempotency-key']);

    const already = deps.runs.byIdempotencyKey(id, key);

    if (already !== null) {
      // A MESMA execução, e não uma nova. É o duplo-clique
      // encontrando a própria primeira metade.
      void reply.code(200);

      return {
        ok: true,
        now: Date.now(),
        run: already,
        operationId: already.operationId,
        message:
          'Esta requisição já tinha sido recebida (mesma Idempotency-Key). Nada foi disparado de ' +
          'novo — esta é a execução que já estava em curso.',
      };
    }

    // ---- 2. o identity digitado ------------------------------
    if (body.identity.trim() !== config.identity) {
      throw new ApiError(
        'WIPE_IDENTITY_MISMATCH',
        `Para zerar este servidor é preciso digitar o identity dele exatamente: "${config.identity}". ` +
          'É a mesma confirmação que se usa para apagar um repositório, e existe porque um wipe ' +
          'apaga o trabalho de todos os jogadores.',
        400,
      );
    }

    // ---- 3. o servidor precisa estar montado -----------------
    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      throw new ApiError(
        'SERVER_NOT_MANAGED',
        `O agente não está cuidando do servidor "${id}" (SERVER_ENABLED). Sem isso ele não sabe ` +
          'parar nem subir o processo, e um wipe é exatamente parar, apagar e subir.',
        409,
      );
    }

    // ---- 4. o plano, quando há um ----------------------------
    const plan = body.planId === undefined || body.planId === null
      ? null
      : deps.schedule.getPlan(id, body.planId);

    if (body.planId !== undefined && body.planId !== null && plan === null) {
      throw new ApiError(
        'UNKNOWN_WIPE_PLAN',
        `Não existe wipe marcado com o id ${String(body.planId)} neste servidor.`,
        404,
      );
    }

    const bpPolicy = body.bpPolicy ?? plan?.bpPolicy ?? 'keep';
    const exec = deps.runs.getExecSettings(id);
    const fullWipe = body.fullWipe ?? exec.pluginData.enabled;

    // ---- 5. as recusas, COM O SERVIDOR AINDA NO AR -----------
    const preview = await buildWipePreview({
      serverId: id,
      identity: config.identity,
      installDir: config.paths.installDir,
      backupsDir: config.paths.backupsDir,
      current: currentWorldOf(config),
      schedule: deps.schedule,
      runs: deps.runs,
      mapPool: deps.mapPool,
      exec,
      bpPolicy,
      fullWipe,
      running: await context.operations.isRunning(),
      rconConnected: context.rcon.isConnected,
    });

    const blocker = preview.blockers[0];

    if (blocker !== undefined) {
      throw new ApiError(blocker.code, blocker.message, 409);
    }

    // ---- 6. abre a linha e dispara a operação ----------------
    //
    // ####  A CORRIDA QUE A CONSULTA DO PASSO 1 NÃO PEGA  ####
    //
    // Duas requisições com a mesma chave chegando JUNTAS não se
    // enxergam na consulta lá em cima: as duas leem "não existe" e
    // as duas seguem. Quem as separa é o índice único do banco — a
    // segunda esbarra nele aqui, e a resposta certa é a mesma do
    // passo 1: devolver a execução que já existe, e não estourar
    // um 500 num botão que zera servidor.
    let run;

    try {
      run = deps.runs.create(
        id,
        {
          planId: plan?.id ?? null,
          idempotencyKey: key,
          kind: plan?.kind ?? 'manual',
          bpPolicy,
          fullWipe,
          wipeAt: body.at ?? Date.now(),
          mapBefore: currentWorldOf(config),
          saveCreatedBefore: await deps.world.saveCreatedAt(id),
        },
        Date.now(),
      );
    } catch (error) {
      const raced = deps.runs.byIdempotencyKey(id, key);

      if (raced === null) {
        throw error;
      }

      void reply.code(200);

      return {
        ok: true,
        now: Date.now(),
        run: raced,
        operationId: raced.operationId,
        message:
          'Duas requisições com a mesma Idempotency-Key chegaram juntas. Só uma execução foi ' +
          'aberta — esta.',
      };
    }

    let operationId: string;

    try {
      const operation = await context.operations.start({
        kind: 'wipe-run',
        wipe: { runId: run.id },
      });

      operationId = operation.id;
    } catch (error) {
      // A operação não começou (outra operação segurando a trava,
      // por exemplo). A linha que acabou de nascer não pode ficar
      // `running` para sempre: ela vira falha com o motivo, e a
      // Idempotency-Key morre com ela — a próxima tentativa precisa
      // de uma chave nova, que é o que o painel gera a cada clique
      // deliberado.
      deps.runs.update(id, run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }

    if (plan !== null) {
      deps.schedule.markPlanStatus(id, plan.id, 'running');
    }

    request.log.warn(
      { server: id, run: run.id, plan: plan?.id ?? null, bpPolicy, fullWipe, operationId, by: operatorOf(request) },
      'WIPE disparado pelo painel',
    );

    void reply.code(202);

    return {
      ok: true,
      now: Date.now(),
      run: deps.runs.get(id, run.id) ?? run,
      operationId,
      message:
        body.at === undefined
          ? 'O wipe começou. Acompanhe os passos na sub-aba Execução.'
          : `O wipe está marcado para ${new Date(body.at).toISOString()}. Os avisos no chat saem ` +
            'até lá, e a execução já está em curso.',
    };
  });

  /**
   * RETOMA do passo que falhou.
   *
   * ####  ELA NÃO RODA TUDO DE NOVO  ####
   *
   * Os passos já `done` são pulados: "de novo" no meio de um wipe
   * significa apagar um mundo que já é o novo. Ver wipe/run.ts.
   */
  app.post('/servers/:id/wipe/runs/:runId/resume', async (request, reply) => {
    const { id, runId } = runParams.parse(request.params);

    assertServer(deps, id);

    const run = deps.runs.get(id, runId);

    if (run === null) {
      throw new ApiError(
        'UNKNOWN_WIPE_RUN',
        `Não existe execução de wipe ${String(runId)} no servidor "${id}".`,
        404,
      );
    }

    if (run.status === 'running') {
      throw new ApiError(
        'WIPE_ALREADY_RUNNING',
        'Esta execução ainda está em curso. Espere ela terminar, ou cancele-a antes de retomar.',
        409,
      );
    }

    if (run.status === 'done') {
      throw new ApiError(
        'WIPE_ALREADY_DONE',
        'Esta execução terminou. Para zerar de novo, dispare um wipe novo — retomar uma que ' +
          'terminou apagaria o mundo que ela mesma criou.',
        409,
      );
    }

    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      throw new ApiError(
        'SERVER_NOT_MANAGED',
        `O agente não está cuidando do servidor "${id}".`,
        409,
      );
    }

    const operation = await context.operations.start({
      kind: 'wipe-run',
      wipe: { runId, resume: true },
    });

    request.log.warn(
      { server: id, run: runId, operation: operation.id, by: operatorOf(request) },
      'execução de wipe retomada pelo painel',
    );

    void reply.code(202);

    return {
      ok: true,
      now: Date.now(),
      run: deps.runs.get(id, runId),
      operationId: operation.id,
      message: 'Retomando do primeiro passo que não terminou.',
    };
  });

  /**
   * Cancela.
   *
   * ####  CANCELAR NÃO DESFAZ  ####
   *
   * Ele pede a parada; o que já foi apagado continua apagado. É por
   * isso que a resposta diz em que passo ela estava — quem cancela
   * um wipe no meio precisa saber se o servidor ficou sem mundo.
   */
  app.post('/servers/:id/wipe/runs/:runId/cancel', (request) => {
    const { id, runId } = runParams.parse(request.params);

    assertServer(deps, id);

    const run = deps.runs.get(id, runId);

    if (run === null) {
      throw new ApiError(
        'UNKNOWN_WIPE_RUN',
        `Não existe execução de wipe ${String(runId)} no servidor "${id}".`,
        404,
      );
    }

    if (run.status !== 'running') {
      return {
        ok: true,
        now: Date.now(),
        run,
        message: 'Esta execução já não estava em curso.',
      };
    }

    const operation = run.operationId === null ? null : deps.store.get(run.operationId);

    if (operation !== null) {
      operation.cancel();
    }

    const current = run.steps.find((step) => step.status === 'running');

    // A linha só é marcada aqui quando não há operação viva para
    // fazê-lo: com ela viva, quem grava o desfecho é a máquina de
    // passos, no fim — e duas escritas do mesmo desfecho dariam
    // duas verdades sobre o mesmo wipe.
    const updated =
      operation === null
        ? deps.runs.update(id, runId, {
            status: 'cancelled',
            finishedAt: Date.now(),
            message: 'Cancelada sem operação viva — o agente tinha reiniciado.',
          })
        : run;

    request.log.warn(
      { server: id, run: runId, step: current?.step ?? null, by: operatorOf(request) },
      'execução de wipe cancelada pelo painel',
    );

    return {
      ok: true,
      now: Date.now(),
      run: updated,
      message:
        current === undefined
          ? 'Cancelamento pedido.'
          : `Cancelamento pedido no passo "${current.step}". O que já foi feito NÃO é desfeito — ` +
            'confira o estado do servidor antes de disparar outro wipe.',
    };
  });
}

/**
 * O mundo em que o servidor está AGORA, do `.ini` dele.
 *
 * A seed vira TEXTO aqui, como em `map_pool.seed` e em `wipes.seed`:
 * ela é transportada, comparada e exibida — nunca somada. É a
 * conversão que impede um `.0` de aparecer no meio do caminho.
 */
function currentWorldOf(config: ServerConfig): {
  readonly level: string | null;
  readonly seed: string | null;
  readonly worldSize: number | null;
  readonly levelUrl: string | null;
} {
  return {
    level: config.level,
    seed: String(config.seed),
    worldSize: config.worldSize,
    // O `.map` de fora, quando há um. É o que decide se um wipe
    // FORÇADO pode MANTER o mundo de hoje — ver
    // `keepBlockedInForced`, em wipe/map-pool.ts —, e é por isso
    // que ele viaja junto do retrato do mundo, e não só na tela.
    levelUrl: config.levelUrl === '' ? null : config.levelUrl,
  };
}

/**
 * @throws {ApiError} 404 quando o servidor não existe neste agente.
 */
function assertServer(deps: WipeRunRoutesDeps, serverId: string): ServerConfig {
  const config = deps.supervisor.configOf(serverId);

  if (config === null) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${serverId}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }

  return config;
}

/**
 * A `Idempotency-Key`, ou a recusa.
 *
 * ####  ELA É OBRIGATÓRIA, E É POR ISSO QUE ELA NÃO TEM PADRÃO  ####
 *
 * Gerar uma chave aqui quando o cliente não manda seria escrever
 * uma chave diferente a cada requisição — ou seja, exatamente o
 * duplo-clique que ela existe para impedir, com a aparência de
 * estar protegido.
 */
function idempotencyKeyOf(header: string | readonly string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const key = typeof raw === 'string' ? raw.trim() : '';

  if (key === '') {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Falta o cabeçalho Idempotency-Key. Ele existe para um duplo-clique não zerar o servidor ' +
        'duas vezes: mande a mesma chave se for a mesma intenção, e uma nova se for outra.',
      400,
    );
  }

  if (key.length > 200) {
    throw new ApiError('IDEMPOTENCY_KEY_TOO_LONG', 'A Idempotency-Key passa de 200 caracteres.', 400);
  }

  return key;
}
