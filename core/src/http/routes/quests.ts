// ============================================================
//  routes/quests.ts  -  as quests, do lado de fora.
//
//  CATÁLOGO — o que o painel administra:
//
//      GET    /quests                    a lista, com filtro
//      GET    /quests/categories         as categorias que existem
//      GET    /quests/:id                uma quest inteira
//      POST   /quests                    cria. 201
//      PUT    /quests/:id                edita
//      PUT    /quests/order              reordena o catálogo inteiro
//      POST   /quests/:id/duplicate      duplica. 201
//      DELETE /quests/:id                apaga
//
//  JOGO E PROGRESSO — o que a tela e o suporte leem:
//
//      GET    /quests/offers             o que aquele jogador pode pegar
//      GET    /quests/progress           quem está fazendo o quê
//      GET    /quests/events             a auditoria
//      GET    /quests/rewards/pending    o que não foi entregue
//      GET    /players/:steamId/quests   as quests DELE
//
//  AÇÃO — os botões do painel:
//
//      POST   /quests/:id/grant             concede a um jogador
//      POST   /quests/progress/:id/set      ajusta um contador
//      POST   /quests/progress/:id/claim    resgata por ele
//      POST   /quests/progress/:id/cancel   cancela
//      POST   /quests/rewards/:id/retry     reentrega o que falhou
//      POST   /quests/wipe                  zera progresso
//
//  CONFIGURAÇÃO E NPCs:
//
//      GET    /quests/settings           por servidor
//      PUT    /quests/settings/:serverId
//      GET    /quests/npcs
//      POST   /quests/npcs               cria. 201
//      PUT    /quests/npcs/:id
//      DELETE /quests/npcs/:id
//
//  ------------------------------------------------------------
//  ####  A REGRA MORA NO SERVIÇO; AQUI É SÓ A BORDA  ####
//
//  Este arquivo valida a entrada, chama o `QuestsService` ou o
//  repositório, e traduz a resposta. Cooldown, cadeia, teto e
//  "os objetivos fecharam?" são todos de `quests/service.ts`, e as
//  frases de erro vêm de lá inteiras. Uma rota que reescrevesse a
//  frase do serviço produziria duas explicações para o mesmo
//  problema.
//
//  ####  AS TRÊS REGRAS QUE NASCEM AQUI  ####
//
//  Elas existem aqui porque só a rota tem os dados para vê-las:
//
//    1. `QUEST_CYCLE` — `requiresQuest` que fecha um ciclo. Só quem
//       tem o catálogo inteiro na mão consegue enxergar;
//    2. `QUEST_IN_USE` — apagar uma quest que gente está fazendo
//       agora. O serviço não sabe que apagar é uma opção;
//    3. `QUEST_NPC_MISSING` — apontar para um NPC inexistente ou de
//       outro servidor. A quest ficaria invisível e ninguém
//       entenderia por quê.
//
//  ####  AS DATAS SAEM COMO EPOCH, COMO ELAS ENTRAM  ####
//
//  Ao contrário do ranking, que formata ISO na borda. A razão é o
//  consumidor: quem lê estas rotas é o painel e a tela do jogo, e
//  os dois fazem contas de tempo (quanto falta do cooldown, quanto
//  durou a tentativa). ISO obrigaria os dois a reconverter.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §11.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { slugify } from '../../db/custom-items-repository.js';
import type { PlayerQuestRecord, QuestsRepository } from '../../db/quests-repository.js';
import type { QuestsService } from '../../quests/service.js';
import {
  questInputSchema,
  questNpcInputSchema,
  questSettingsSchema,
  type QuestInput,
} from '../../types/quests.js';
import { ApiError } from '../error-response.js';

export interface QuestRoutesDeps {
  readonly repository: QuestsRepository;
  readonly service: QuestsService;
  /** Para conferir que um `serverId` existe antes de gravá-lo. */
  readonly servers: { list(): readonly { readonly id: string }[] };
  /**
   * Avisado quando o CATÁLOGO muda.
   *
   * ####  NA PRÁTICA O CICLO JÁ NOTARIA  ####
   *
   * O coletor recalcula o que observar a cada rodada, do banco: uma
   * missão nova entra sozinha. Isto só ADIANTA o momento — de até
   * quinze segundos para o próximo instante.
   *
   * Para o NPC a diferença é maior e é visível: o admin clica em
   * "apagar" no painel e o boneco tem de sumir do mapa, não daqui a
   * um ciclo.
   *
   * Ausente = o agente não montou a sincronização, e o ciclo faz o
   * trabalho sozinho.
   */
  readonly onCatalogChanged?: () => void;
  readonly onNpcsChanged?: (serverId: string) => void;
}

// ------------------------------------------------------------
//  As réguas da borda
// ------------------------------------------------------------

const idParams = z.object({ id: z.string().min(1).max(64) });
const numericParams = z.object({ id: z.coerce.number().int().positive() });
const steamIdParams = z.object({ steamId: z.string().regex(/^\d{17}$/) });

/** Quem mandou e por quê. Toda ação de suporte carrega os dois. */
const actorBody = z.object({
  actor: z.string().min(1).max(60).default('painel'),
  reason: z.string().max(200).default(''),
});

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ------------------------------------------------------------

export function registerQuestRoutes(app: FastifyInstance, deps: QuestRoutesDeps): void {
  // ======================================================
  //  CATÁLOGO — leitura
  // ======================================================

  /**
   * As categorias, com quantas quests cada uma tem.
   *
   * Registrada ANTES da rota de `:id` por clareza — o Fastify
   * prefere o caminho estático de qualquer jeito, mas ler o arquivo
   * na ordem em que ele resolve poupa a dúvida.
   */
  app.get('/quests/categories', async () => {
    return { ok: true, categories: deps.repository.categories() };
  });

  app.get('/quests', async (request) => {
    const query = z
      .object({
        category: z.string().max(40).optional(),
        serverId: z.string().max(64).optional(),
        enabled: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
      })
      .parse(request.query);

    // `listForServer` já aplica o "sem restrição vale em todos" e
    // corta as desligadas — é a consulta da tela do jogo, e usá-la
    // aqui é o que garante que o painel vê o que o jogo vê.
    const all =
      query.serverId === undefined
        ? deps.repository.list()
        : deps.repository.listForServer(query.serverId);

    const quests = all.filter(
      (quest) =>
        (query.category === undefined || quest.category === query.category) &&
        (query.enabled === undefined || quest.enabled === query.enabled),
    );

    return { ok: true, quests };
  });

  app.get('/quests/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const quest = requireQuest(deps, id);

    return {
      ok: true,
      quest,
      // O número que o botão de apagar precisa mostrar ANTES de
      // apagar. Ver `QUEST_IN_USE`.
      liveCount: deps.repository.liveCountOf(id),
    };
  });

  // ======================================================
  //  CATÁLOGO — escrita
  // ======================================================

  app.post('/quests', async (request, reply) => {
    const body = questInputSchema.parse(request.body);

    assertServers(deps, body.servers);
    assertNpc(deps, body);
    assertChain(deps, null, body.requiresQuest);

    const quest = deps.repository.create(freeId(deps, body.title), body);

    deps.onCatalogChanged?.();

    return reply.status(201).send({ ok: true, quest });
  });

  app.put('/quests/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = questInputSchema.parse(request.body);

    requireQuest(deps, id);
    assertServers(deps, body.servers);
    assertNpc(deps, body);
    assertChain(deps, id, body.requiresQuest);

    const quest = deps.repository.update(id, body);

    deps.onCatalogChanged?.();

    return { ok: true, quest };
  });

  /**
   * Reordena o catálogo INTEIRO.
   *
   * A lista chega completa, na ordem nova. Uma lista parcial seria
   * aceita pelo repositório — ele ignora id que não existe —, e os
   * ausentes ficariam com a posição antiga, cruzada com as novas: o
   * defeito só apareceria na próxima vez que alguém abrisse a tela.
   * É a mesma régua do catálogo de rankings.
   */
  app.put('/quests/order', async (request) => {
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) })
      .parse(request.body);

    const known = new Set(deps.repository.list().map((quest) => quest.id));
    const missing = [...known].filter((id) => !ids.includes(id));

    if (missing.length > 0) {
      throw new ApiError(
        'QUEST_ORDER_INCOMPLETE',
        `A ordem precisa vir com o catálogo inteiro. Faltaram: ${missing.join(', ')}.`,
        400,
      );
    }

    deps.repository.reorder(ids);
    deps.onCatalogChanged?.();

    return { ok: true, quests: deps.repository.list() };
  });

  /**
   * Duplica.
   *
   * É o que faz a semanal nascer da diária sem redigitar oito
   * objetivos. Ela nasce DESLIGADA de propósito: uma cópia que
   * entrasse no ar antes de alguém trocar o título apareceria no
   * jogo como duas quests iguais.
   */
  app.post('/quests/:id/duplicate', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const source = requireQuest(deps, id);
    const { title } = z
      .object({ title: z.string().min(1).max(120).default(`${source.title} (cópia)`) })
      .parse(request.body ?? {});

    const copy = deps.repository.create(freeId(deps, title), {
      ...source,
      // Os arrays são copiados, e não referenciados: o que sai do
      // repositório é `readonly`, e uma cópia que compartilhasse a
      // lista com o original amarraria as duas quests.
      servers: [...source.servers],
      objectives: [...source.objectives],
      rewards: [...source.rewards],
      title,
      enabled: false,
      // A cadeia NÃO é copiada: duas quests exigindo a mesma
      // anterior é legítimo, mas herdar isso em silêncio produz
      // uma cópia que ninguém consegue pegar e que parece
      // quebrada.
      requiresQuest: null,
    });

    deps.onCatalogChanged?.();

    return reply.status(201).send({ ok: true, quest: copy });
  });

  /**
   * Apaga.
   *
   * ####  A CASCATA É GRANDE, E ELA PRECISA SER DITA  ####
   *
   * Apagar leva objetivos, recompensas, ligações de servidor e
   * TODAS as tentativas, com o progresso de quem está no meio dela.
   * Por isso a recusa com contagem: quem clica precisa ver quantos
   * são antes de confirmar com `force`.
   */
  app.delete('/quests/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { force } = z
      .object({ force: z.coerce.boolean().default(false) })
      .parse(request.query ?? {});

    requireQuest(deps, id);

    const live = deps.repository.liveCountOf(id);

    if (live > 0 && !force) {
      throw new ApiError(
        'QUEST_IN_USE',
        `${String(live)} jogador(es) estão com esta quest em andamento. Apagar leva o progresso ` +
          'deles junto. Repita com `force=true` se for isso mesmo.',
        409,
      );
    }

    const removed = deps.repository.remove(id);

    deps.onCatalogChanged?.();

    return { ok: true, removed, live };
  });

  // ======================================================
  //  JOGO E PROGRESSO
  // ======================================================

  /**
   * O que aquele jogador pode pegar agora.
   *
   * A lista vem COM os bloqueados dentro, cada um com o motivo: a
   * tela precisa mostrar "volta em 4h" e "conclua Boas-vindas
   * primeiro". Uma quest que simplesmente some é uma quest sobre a
   * qual ninguém consegue perguntar.
   */
  app.get('/quests/offers', async (request) => {
    const query = z
      .object({
        serverId: z.string().min(1).max(64),
        steamId: z.string().regex(/^\d{17}$/),
        npcId: z.string().max(64).optional(),
      })
      .parse(request.query);

    return { ok: true, offers: await deps.service.offersFor(query) };
  });

  /**
   * Quem está fazendo o quê.
   *
   * ####  ELA EXIGE UM RECORTE  ####
   *
   * `steamId` ou `questId`, e a recusa diz isso. Sem um dos dois, a
   * consulta varreria `player_quests` inteira — uma tabela que
   * cresce com jogador × quest × tentativa, e que numa rede de seis
   * meses tem centenas de milhares de linhas. A tela do painel
   * sempre tem um dos dois.
   */
  app.get('/quests/progress', async (request) => {
    const query = z
      .object({
        steamId: z.string().regex(/^\d{17}$/).optional(),
        questId: z.string().max(64).optional(),
        serverId: z.string().max(64).optional(),
        status: z.enum(['active', 'completed', 'claimed', 'abandoned']).optional(),
      })
      .and(pagination)
      .parse(request.query);

    if (query.steamId === undefined && query.questId === undefined) {
      throw new ApiError(
        'QUEST_PROGRESS_NO_FILTER',
        'Diga de quem ou de qual quest: passe `steamId` ou `questId`.',
        400,
      );
    }

    const rows =
      query.questId === undefined
        ? deps.repository.historyOf(query.steamId as string, query)
        : deps.repository.playersOf(query.questId, query);

    // O recorte que a consulta escolhida não aplicou. São poucos
    // por página, então filtrar aqui é honesto — e é o que evita
    // dois métodos quase iguais no repositório.
    const progress = rows.filter(
      (row) =>
        (query.steamId === undefined || row.steamId === query.steamId) &&
        (query.serverId === undefined || row.serverId === query.serverId) &&
        (query.status === undefined || row.status === query.status),
    );

    return { ok: true, progress: progress.map((row) => toProgressBody(deps, row)) };
  });

  /** A ficha dele: o que está fazendo agora, e o que já fez. */
  app.get('/players/:steamId/quests', async (request) => {
    const { steamId } = steamIdParams.parse(request.params);
    const query = z
      .object({ serverId: z.string().max(64).optional() })
      .and(pagination)
      .parse(request.query ?? {});

    const history = deps.repository.historyOf(steamId, query);

    return {
      ok: true,
      quests: history.map((row) => toProgressBody(deps, row)),
    };
  });

  app.get('/quests/events', async (request) => {
    const query = z
      .object({
        steamId: z.string().regex(/^\d{17}$/).optional(),
        questId: z.string().max(64).optional(),
        serverId: z.string().max(64).optional(),
        kind: z
          .enum(['accept', 'progress', 'complete', 'claim', 'abandon', 'reset', 'reward_failed'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query ?? {});

    return { ok: true, events: deps.repository.events(query) };
  });

  /**
   * O que a quest prometeu e não saiu.
   *
   * ####  ELA É A LISTA DE TAREFAS DO ADMIN  ####
   *
   * Cada linha é uma recompensa que falhou — inventário cheio,
   * carteira sem resposta, kit apagado. A tentativa continua
   * `claimed`: ela nunca deixou de estar, porque marcar antes de
   * entregar é o desenho (§6.4 do plano). O botão de reentregar
   * fica em `/quests/rewards/:id/retry`.
   */
  app.get('/quests/rewards/pending', async (request) => {
    const query = z
      .object({ serverId: z.string().max(64).optional() })
      .and(pagination)
      .parse(request.query ?? {});

    const failures = deps.repository.events({ ...query, kind: 'reward_failed' });

    return {
      ok: true,
      pending: failures.map((event) => ({
        ...event,
        // A tentativa pode ter sumido junto com a quest apagada. A
        // linha da auditoria fica de qualquer jeito — é justamente
        // ela que responde "o que aconteceu com o meu prêmio?".
        attempt: findAttempt(deps, event.steamId, event.questId, event.attempt),
      })),
    };
  });

  // ======================================================
  //  AÇÃO
  // ======================================================

  /** O suporte dá a quest a quem não poderia pegá-la. */
  app.post('/quests/:id/grant', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        serverId: z.string().min(1).max(64),
        steamId: z.string().regex(/^\d{17}$/),
      })
      .and(actorBody)
      .parse(request.body);

    const view = await deps.service.accept({ ...body, questId: id, force: true });

    return reply.status(201).send({ ok: true, quest: view });
  });

  /**
   * Ajusta um contador à mão.
   *
   * ####  ELE NÃO CONCLUI SOZINHO  ####
   *
   * Pôr o contador no alvo deixa a quest pronta para o resgate, mas
   * quem a marca `completed` é o caminho normal (o lote ou o
   * `claim`). Duas portas para o mesmo estado divergiriam na
   * primeira mudança da regra de conclusão.
   */
  app.post('/quests/progress/:id/set', async (request) => {
    const { id } = numericParams.parse(request.params);
    const body = z
      .object({
        objectiveSeq: z.number().int().min(0).max(31),
        value: z.number().int().min(0).max(100_000_000),
      })
      .and(actorBody)
      .parse(request.body);

    const attempt = requireAttempt(deps, id);

    deps.repository.setProgress(id, body.objectiveSeq, body.value);
    deps.repository.recordEvent({
      serverId: attempt.serverId,
      steamId: attempt.steamId,
      questId: attempt.questId,
      attempt: attempt.attempt,
      kind: 'progress',
      detail: { objectiveSeq: body.objectiveSeq, value: body.value, reason: body.reason },
      source: 'panel',
      actor: body.actor,
    });

    return { ok: true, quest: deps.service.viewOf(requireAttempt(deps, id)) };
  });

  /** Resgata por ele. É o "já concluiu, entrega logo" do suporte. */
  app.post('/quests/progress/:id/claim', async (request) => {
    const { id } = numericParams.parse(request.params);
    const body = actorBody.parse(request.body ?? {});

    return { ok: true, result: await deps.service.claim({ playerQuestId: id, actor: body.actor }) };
  });

  app.post('/quests/progress/:id/cancel', async (request) => {
    const { id } = numericParams.parse(request.params);
    const body = actorBody.parse(request.body ?? {});

    requireAttempt(deps, id);

    return {
      ok: true,
      cancelled: deps.service.cancel({
        playerQuestId: id,
        actor: body.actor,
        reason: body.reason,
      }),
    };
  });

  /**
   * Reentrega o que falhou.
   *
   * Moeda e ponto são idempotentes (a `reference` e o `eventId` são
   * estáveis); item, kit e VIP SAEM DE NOVO. Por isso a resposta
   * traz o desfecho de cada um: quem clica precisa ver o que
   * acabou de sair.
   */
  app.post('/quests/rewards/:id/retry', async (request) => {
    const { id } = numericParams.parse(request.params);
    const body = actorBody.parse(request.body ?? {});

    return {
      ok: true,
      result: await deps.service.retryRewards({ playerQuestId: id, actor: body.actor }),
    };
  });

  /**
   * Zera progresso.
   *
   * O recorte é obrigatório, e quem cobra é o repositório
   * (`QUEST_WIPE_TOO_BROAD`): zerar todos os jogadores de todos os
   * servidores por um corpo vazio é o tipo de acidente que não se
   * desfaz.
   *
   * `respectPolicy` separa as duas chamadas: o wipe do mundo
   * respeita o `wipe_policy` de cada quest; o botão do painel zera o
   * que foi pedido, porque quem clicou ali disse o que queria.
   */
  app.post('/quests/wipe', async (request) => {
    const body = z
      .object({
        serverId: z.string().max(64).optional(),
        questId: z.string().max(64).optional(),
        steamId: z.string().regex(/^\d{17}$/).optional(),
        respectPolicy: z.boolean().default(false),
      })
      .and(actorBody.extend({ reason: z.string().min(1).max(200) }))
      .parse(request.body);

    return { ok: true, wiped: deps.repository.wipeProgress(body) };
  });

  // ======================================================
  //  CONFIGURAÇÃO
  // ======================================================

  app.get('/quests/settings', async (request) => {
    const { serverId } = z
      .object({ serverId: z.string().max(64).optional() })
      .parse(request.query ?? {});

    const ids =
      serverId === undefined ? deps.servers.list().map((server) => server.id) : [serverId];

    return {
      ok: true,
      settings: ids.map((id) => ({ serverId: id, ...deps.repository.settingsOf(id) })),
    };
  });

  app.put('/quests/settings/:serverId', async (request) => {
    const { serverId } = z.object({ serverId: z.string().min(1).max(64) }).parse(request.params);
    const body = questSettingsSchema.parse(request.body);

    assertServers(deps, [serverId]);

    return { ok: true, settings: deps.repository.saveSettings(serverId, body) };
  });

  // ======================================================
  //  NPCs
  // ======================================================

  app.get('/quests/npcs', async (request) => {
    const { serverId } = z
      .object({ serverId: z.string().max(64).optional() })
      .parse(request.query ?? {});

    const npcs = deps.repository.listNpcs(serverId).map((npc) => ({
      ...npc,
      // Quantas quests apontam para ele. É o aviso do botão de
      // apagar, pelo mesmo motivo do `liveCount` da quest.
      quests: deps.repository.questsOfNpc(npc.id),
    }));

    return { ok: true, npcs };
  });

  /**
   * Cria um NPC.
   *
   * ####  O CAMINHO NORMAL É O JOGO, E NÃO ESTA ROTA  ####
   *
   * Ninguém escolhe coordenada digitando número: o admin vai até o
   * lugar, olha para onde o NPC deve olhar, e usa `/questnpc add`.
   * Quem chama isto é o próprio plugin, com a posição dele — e o
   * painel, para o caso de recriar um que foi apagado sem querer, a
   * partir da posição que o histórico mostra.
   */
  app.post('/quests/npcs', async (request, reply) => {
    const body = questNpcInputSchema.parse(request.body);

    assertServers(deps, [body.serverId]);

    const npc = deps.repository.createNpc(freeNpcId(deps, body.name), body);

    deps.onNpcsChanged?.(body.serverId);

    return reply.status(201).send({ ok: true, npc });
  });

  app.put('/quests/npcs/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = questNpcInputSchema.parse(request.body);

    if (deps.repository.getNpc(id) === null) {
      throw new ApiError('QUEST_NPC_NOT_FOUND', `Não existe o NPC "${id}".`, 404);
    }

    assertServers(deps, [body.serverId]);

    const updated = deps.repository.updateNpc(id, body);

    deps.onNpcsChanged?.(body.serverId);

    return { ok: true, npc: updated };
  });

  /**
   * Apaga o NPC.
   *
   * A quest dele NÃO vai junto — não há FK, e é de propósito: ela
   * volta a ser uma quest de menu, com o progresso de quem estava
   * fazendo intacto. A resposta diz quais quests ficaram órfãs para
   * que o painel possa avisar.
   */
  app.delete('/quests/npcs/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    if (deps.repository.getNpc(id) === null) {
      throw new ApiError('QUEST_NPC_NOT_FOUND', `Não existe o NPC "${id}".`, 404);
    }

    const orphaned = deps.repository.questsOfNpc(id);
    const serverId = deps.repository.getNpc(id)?.serverId;
    const removed = deps.repository.removeNpc(id);

    // O boneco precisa sumir do MAPA, e não só do banco: o admin
    // clicou em apagar e está olhando para o mundo.
    if (serverId !== undefined) {
      deps.onNpcsChanged?.(serverId);
    }

    return { ok: true, removed, orphaned };
  });
}

// ------------------------------------------------------------
//  As regras que nascem na borda
// ------------------------------------------------------------

function requireQuest(deps: QuestRoutesDeps, id: string) {
  const quest = deps.repository.get(id);

  if (quest === null) {
    throw new ApiError('QUEST_NOT_FOUND', `Não existe a quest "${id}".`, 404);
  }

  return quest;
}

function requireAttempt(deps: QuestRoutesDeps, id: number): PlayerQuestRecord {
  const attempt = deps.repository.attempt(id);

  if (attempt === null) {
    throw new ApiError(
      'QUEST_ATTEMPT_NOT_FOUND',
      `Não existe a tentativa ${String(id)}.`,
      404,
    );
  }

  return attempt;
}

/**
 * Um servidor que não existe vira quest invisível.
 *
 * A FK do banco recusaria de qualquer jeito, mas a mensagem dela
 * ("FOREIGN KEY constraint failed") não diz qual dos seis ids
 * estava errado.
 */
function assertServers(deps: QuestRoutesDeps, ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }

  const known = new Set(deps.servers.list().map((server) => server.id));
  const unknown = ids.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new ApiError(
      'QUEST_SERVER_UNKNOWN',
      `Estes servidores não existem: ${unknown.join(', ')}.`,
      400,
    );
  }
}

/**
 * O NPC precisa existir, e no servidor certo.
 *
 * ####  E É POR ISSO QUE ESTA REGRA MORA NA ROTA  ####
 *
 * `quests.npc_id` não tem FK (a migração 047 pode chegar depois da
 * 046, ver o cabeçalho delas), então o banco aceita qualquer texto.
 * Uma quest apontando para um NPC que não existe — ou que está
 * noutro mundo — não apareceria em lugar nenhum: nem no menu, por
 * ter NPC; nem no NPC, por ele não estar lá.
 *
 * Ela também cobre o destino da ENTREGA, que é um NPC no `target`
 * do objetivo.
 */
function assertNpc(deps: QuestRoutesDeps, body: QuestInput): void {
  const targets: { readonly id: string; readonly what: string }[] = [];

  if (body.npcId !== null) {
    targets.push({ id: body.npcId, what: 'O NPC desta quest' });

    // ####  O NPC DE ORIGEM NÃO PODE SER DE ENTREGA  ####
    //
    // Um NPC `delivery` existe para RECEBER pacote: ele não abre
    // lista de missões (ver `offersFor`). Uma quest presa a ele
    // ficaria invisível — o mesmo defeito do NPC inexistente, e por
    // isso o mesmo código.
    const origin = deps.repository.getNpc(body.npcId);

    if (origin !== null && origin.kind === 'delivery') {
      throw new ApiError(
        'QUEST_NPC_MISSING',
        `O NPC "${body.npcId}" é de ENTREGA: ele recebe pacotes e não oferece missões. ` +
          'Esta quest ficaria invisível no jogo.',
        400,
      );
    }
  }

  for (const objective of body.objectives) {
    if (objective.kind === 'deliver' && objective.target !== null) {
      targets.push({ id: objective.target, what: 'O NPC de destino da entrega' });
    }
  }

  for (const target of targets) {
    const npc = deps.repository.getNpc(target.id);

    if (npc === null) {
      throw new ApiError(
        'QUEST_NPC_MISSING',
        `${target.what} ("${target.id}") não existe. A quest ficaria invisível no jogo.`,
        400,
      );
    }

    // A quest é de rede, mas o NPC é de UM servidor. Restringi-la
    // aos servidores dele é decisão do admin — o que a rota impede
    // é a combinação impossível: quest presa a um servidor onde o
    // NPC dela não está.
    if (body.servers.length > 0 && !body.servers.includes(npc.serverId)) {
      throw new ApiError(
        'QUEST_NPC_MISSING',
        `${target.what} ("${target.id}") está em "${npc.serverId}", que não está na lista de ` +
          'servidores desta quest.',
        400,
      );
    }
  }
}

/**
 * A cadeia não pode fechar um ciclo.
 *
 * A → B → C → A faria as três sumirem para sempre, e ninguém
 * entenderia por quê: cada uma diria "conclua a anterior primeiro",
 * e a anterior diria o mesmo.
 *
 * `questId` é `null` na criação — uma quest que ainda não existe
 * não pode estar num ciclo, mas a cadeia dela ainda pode apontar
 * para uma quest inexistente, e isso também é recusado.
 */
function assertChain(
  deps: QuestRoutesDeps,
  questId: string | null,
  requiresQuest: string | null,
): void {
  if (requiresQuest === null) {
    return;
  }

  if (requiresQuest === questId) {
    throw new ApiError('QUEST_CYCLE', 'Uma quest não pode exigir a si mesma.', 400);
  }

  if (deps.repository.get(requiresQuest) === null) {
    throw new ApiError(
      'QUEST_CHAIN_MISSING',
      `A quest exigida ("${requiresQuest}") não existe.`,
      400,
    );
  }

  if (questId === null) {
    return;
  }

  // Sobe a corrente a partir do pré-requisito. Se ela voltar a
  // esta quest, o ciclo se fecharia com a gravação.
  const seen = new Set<string>([questId]);
  let current: string | null = requiresQuest;

  while (current !== null) {
    if (seen.has(current)) {
      throw new ApiError(
        'QUEST_CYCLE',
        `Isto fecharia um ciclo de pré-requisitos em "${current}": as quests do ciclo nunca ` +
          'apareceriam para ninguém.',
        400,
      );
    }

    seen.add(current);
    current = deps.repository.get(current)?.requiresQuest ?? null;
  }
}

// ------------------------------------------------------------
//  Tradução
// ------------------------------------------------------------

/**
 * Um id livre, derivado do título.
 *
 * "Diária: Minerador" vira `diaria-minerador`; se já existir, vira
 * `diaria-minerador-2`. O sufixo numérico é feio de propósito: ele
 * avisa quem cadastrou que já existe uma quest com aquele nome. É a
 * mesma função e a mesma escolha do item custom.
 */
function freeId(deps: QuestRoutesDeps, title: string): string {
  const base = slugify(title);

  if (deps.repository.get(base) === null) {
    return base;
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;

    if (deps.repository.get(candidate) === null) {
      return candidate;
    }
  }

  throw new ApiError(
    'QUEST_ID_TAKEN',
    `Não achei um id livre para "${title}" — há 99 quests com esse nome?`,
    409,
  );
}

function freeNpcId(deps: QuestRoutesDeps, name: string): string {
  const base = slugify(name);

  if (deps.repository.getNpc(base) === null) {
    return base;
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;

    if (deps.repository.getNpc(candidate) === null) {
      return candidate;
    }
  }

  throw new ApiError(
    'QUEST_NPC_ID_TAKEN',
    `Não achei um id livre para "${name}" — há 99 NPCs com esse nome?`,
    409,
  );
}

/**
 * A tentativa, como o painel a lê.
 *
 * O `viewOf` do serviço monta a frase de cada objetivo e diz se
 * fechou — é o mesmo corpo que a tela do jogo recebe, e é de
 * propósito: duas formas para a mesma tentativa dariam duas
 * contagens de progresso.
 */
function toProgressBody(deps: QuestRoutesDeps, attempt: PlayerQuestRecord) {
  return {
    ...deps.service.viewOf(attempt),
    serverId: attempt.serverId,
    steamId: attempt.steamId,
    attempt: attempt.attempt,
    claimedAt: attempt.claimedAt,
    cooldownUntil: attempt.cooldownUntil,
  };
}

function findAttempt(
  deps: QuestRoutesDeps,
  steamId: string,
  questId: string,
  attempt: number,
): PlayerQuestRecord | null {
  return (
    deps.repository
      .historyOf(steamId, { limit: 500 })
      .find((row) => row.questId === questId && row.attempt === attempt) ?? null
  );
}
