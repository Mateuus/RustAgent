// ============================================================
//  routes/messages.ts  -  o que o servidor fala sozinho.
//
//      GET    /messages                  a lista da rede
//      POST   /messages                  cria
//      PATCH  /messages/:messageId       edita (parcial)
//      DELETE /messages/:messageId       remove
//      POST   /messages/reorder          a ordem da tela
//      POST   /messages/:messageId/test  manda AGORA
//      GET    /messages/:messageId/log   saiu mesmo?
//      POST   /chat/broadcast            uma fala avulsa
//
//  ####  A MENSAGEM É DE REDE  ####
//
//  Como VIP, kit e loja. Por isso não há `/servers/:id/messages`:
//  escreve-se uma vez e escolhe-se em quais servidores ela sai,
//  numa lista de alvos. Lista VAZIA = todos.
//
//  ####  PATCH, E NÃO PUT  ####
//
//  Diferente dos kits, e por um motivo concreto: a lista liga e
//  desliga uma mensagem com UM clique, e mandar o corpo inteiro
//  para trocar um booleano faria a tela reenviar o texto e o ritmo
//  a cada clique — com a chance de sobrescrever o que outra aba
//  acabou de gravar.
//
//  O que o PATCH parcial exige em troca é que a COERÊNCIA seja
//  conferida no resultado da mistura, e não no que chegou: trocar
//  só o `scheduleKind` para `weekly` deixaria a mensagem sem dia
//  nenhum marcado. É o que `assertCoherent` faz, embaixo.
//
//  ####  `next_at` NÃO VEM DO CORPO  ####
//
//  Ele é ESTADO do relógio, e é sempre recalculado aqui. Uma tela
//  que pudesse mandá-lo empurraria uma mensagem para daqui a um ano
//  sem ninguém entender por quê.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { MessagesRepository } from '../../db/messages-repository.js';
import type { MessagesService } from '../../messages/service.js';
import { describeSchedule } from '../../messages/schedule.js';
import { isValidTimeZone, parseMinutesOfDay } from '../../messages/timezone-bridge.js';
import type { VariableRegistry } from '../../messages/variables.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import type { MessageInput, MessageView } from '../../types/messages.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface MessageRoutesDeps {
  readonly repository: MessagesRepository;
  readonly service: MessagesService;
  readonly variables: VariableRegistry;
  readonly supervisor: ServerSupervisor;
}

/** Tamanho de página do log. */
export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 500;

/**
 * O piso do `interval`, em segundos.
 *
 * Dez segundos não é uma limitação técnica: é o ponto em que um
 * aviso vira ruído e os jogadores desligam o chat. Quem quer falar
 * mais que isso quer um plugin, e não um agendador.
 */
export const MIN_INTERVAL_SECONDS = 10;

/** O teto: 30 dias. Acima disso o ritmo certo é `weekly` ou `once`. */
export const MAX_INTERVAL_SECONDS = 2_592_000;

/** O fuso padrão do projeto. Ver Docs/16 §14, decisão 7. */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

const idParams = z.object({ messageId: z.coerce.number().int().positive() });

const logQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LOG_LIMIT).optional(),
});

const testBody = z
  .object({
    /** Só neste servidor. Ausente = em todos os alvos da mensagem. */
    serverId: z.string().min(1).optional(),
  })
  .strict();

const reorderBody = z.object({ ids: z.array(z.number().int().positive()) }).strict();

/** `HH:MM`, e nada mais. Ver types/messages.ts. */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'o horário é HH:MM, de 00:00 a 23:59');

/**
 * Cor em hexadecimal.
 *
 * A mesma trava do game/chat.ts, e pelo mesmo motivo: a cor vai
 * para o `<color=…>` do jogo e para o `style` da prévia na tela.
 * Sem a conferência, o campo seria um caminho para injetar
 * marcação.
 */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'a cor é hexadecimal, como #ffcc00');

/** Os campos que descrevem uma mensagem. Um só, para o POST e o PATCH. */
const messageShape = {
  name: z.string().trim().min(1).max(64),
  /**
   * 512 é o que a tela mostra no contador.
   *
   * O teto existe porque o comando viaja pelo RCON, e um texto de
   * dez mil caracteres é um frame que chega truncado ao plugin — um
   * aviso pela metade que PARECE ter funcionado.
   */
  text: z.string().trim().min(1).max(512),
  enabled: z.boolean(),
  scheduleKind: z.enum(['interval', 'daily', 'weekly', 'once']),
  everySeconds: z
    .number()
    .int()
    .min(MIN_INTERVAL_SECONDS)
    .max(MAX_INTERVAL_SECONDS)
    .nullable(),
  timeOfDay: timeOfDay.nullable(),
  /** 0 = domingo. */
  weekdays: z.array(z.number().int().min(0).max(6)),
  /**
   * O instante do `once`, em ISO com fuso.
   *
   * ISO na borda e epoch ms por dentro, como o `expiresAt` do VIP:
   * é a convenção do projeto, e ela existe para o JSON não obrigar
   * cada consumidor a saber a unidade do número.
   */
  runAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .transform((value) => (value === null ? null : Date.parse(value))),
  timeZone: z.string().trim().min(1).max(64),
  windowFrom: timeOfDay.nullable(),
  windowTo: timeOfDay.nullable(),
  onlyWithPlayers: z.boolean(),
  minPlayers: z.number().int().min(0).max(1000),
  tag: z.string().trim().min(1).max(32).nullable(),
  tagColor: hexColor.nullable(),
  color: hexColor.nullable(),
  /** O tamanho da fonte no chat. `null` = o padrão do plugin. */
  size: z.number().int().min(8).max(40).nullable(),
  targets: z.array(z.string().min(1)),
};

/** O corpo de criação: tudo, com padrões para o que a tela omite. */
const createBody = z
  .object({
    ...messageShape,
    enabled: messageShape.enabled.default(true),
    everySeconds: messageShape.everySeconds.default(null),
    timeOfDay: messageShape.timeOfDay.default(null),
    weekdays: messageShape.weekdays.default([]),
    runAt: messageShape.runAt.default(null),
    timeZone: messageShape.timeZone.default(DEFAULT_TIME_ZONE),
    windowFrom: messageShape.windowFrom.default(null),
    windowTo: messageShape.windowTo.default(null),
    onlyWithPlayers: messageShape.onlyWithPlayers.default(false),
    minPlayers: messageShape.minPlayers.default(1),
    tag: messageShape.tag.default(null),
    tagColor: messageShape.tagColor.default(null),
    color: messageShape.color.default(null),
    size: messageShape.size.default(null),
    targets: messageShape.targets.default([]),
  })
  .strict();

/** O corpo de edição: só o que mudou. */
const patchBody = z.object(messageShape).partial().strict();

/** A fala avulsa do `POST /chat/broadcast`. */
const broadcastBody = z
  .object({
    serverId: z.string().min(1),
    text: z.string().trim().min(1).max(512),
    tag: z.string().trim().min(1).max(32).optional(),
    tagColor: hexColor.optional(),
    color: hexColor.optional(),
    size: z.number().int().min(8).max(40).optional(),
    /** Só para este jogador. Ausente = para todo mundo que está online. */
    steamId: z.string().min(1).optional(),
  })
  .strict();

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRoutesDeps): void {
  app.get('/messages', async () => ({
    ok: true,
    messages: deps.repository.list().map(toApi),
    /**
     * Os nomes que o agente sabe trocar, para a tela listá-los sem
     * repetir a lista.
     *
     * Ela vem do REGISTRO, e não de uma constante do painel: quem
     * registra `{wipe.*}` é outra frente, e uma lista escrita à mão
     * no painel ficaria mentindo no dia em que ela entrasse.
     */
    variables: {
      names: deps.variables.names(),
      namespaces: deps.variables.namespaces(),
    },
  }));

  app.post('/messages', async (request, reply) => {
    const body = createBody.parse(request.body);

    assertServers(deps, body.targets);
    assertTimeZone(body.timeZone);
    assertCoherent(body);

    const message = deps.repository.create(
      body,
      deps.service.nextAtFor(body, body.enabled),
    );

    request.log.info(
      {
        message: message.id,
        name: message.name,
        kind: message.scheduleKind,
        targets: message.targets,
        by: operatorOf(request),
      },
      'mensagem criada pelo painel',
    );

    return reply.status(201).send({
      ok: true,
      message: toApi(message),
      detail:
        `Mensagem "${message.name}" criada (${describeSchedule(message)}).` +
        (message.nextAt === null
          ? ' Ela ainda NÃO tem próxima saída — confira o ritmo.'
          : '') +
        (message.targets.length === 0
          ? ' Ela sai em TODOS os servidores.'
          : ` Sai em ${message.targets.join(', ')}.`),
    });
  });

  /**
   * Edita o que veio, e só isso.
   *
   * A coerência é conferida no RESULTADO da mistura: trocar só o
   * `scheduleKind` para `weekly` deixaria a mensagem sem dia
   * nenhum, e o banco aceitaria (as colunas são anuláveis). O
   * jogador descobriria isso como "a mensagem nunca sai".
   */
  app.patch('/messages/:messageId', async (request) => {
    const { messageId } = idParams.parse(request.params);
    const patch = patchBody.parse(request.body);
    const current = deps.repository.get(messageId);

    if (current === null) {
      throw new ApiError(
        'MESSAGE_NOT_FOUND',
        `Não existe mensagem com o id ${String(messageId)}.`,
        404,
      );
    }

    const merged = mergeInput(current, patch);

    assertServers(deps, merged.targets);
    assertTimeZone(merged.timeZone);
    assertCoherent(merged);

    const saved = deps.repository.update(
      messageId,
      merged,
      nextAtAfterEdit(deps, current, merged),
    );

    if (saved === null) {
      throw new ApiError(
        'MESSAGE_NOT_FOUND',
        `Não existe mensagem com o id ${String(messageId)}.`,
        404,
      );
    }

    request.log.info(
      { message: saved.id, name: saved.name, by: operatorOf(request) },
      'mensagem alterada pelo painel',
    );

    return {
      ok: true,
      message: toApi(saved),
      detail: saved.enabled
        ? `Mensagem "${saved.name}" gravada (${describeSchedule(saved)}).`
        : `Mensagem "${saved.name}" gravada e DESLIGADA: ela fica na lista e não sai.`,
    };
  });

  /**
   * Remove a mensagem, e o log dela vai junto pela cascata.
   *
   * Quem quer calar sem perder o histórico desliga
   * (`enabled: false`) — e é isso que a frase diz.
   */
  app.delete('/messages/:messageId', async (request) => {
    const { messageId } = idParams.parse(request.params);
    const message = deps.repository.get(messageId);

    if (message === null || !deps.repository.remove(messageId)) {
      throw new ApiError(
        'MESSAGE_NOT_FOUND',
        `Não existe mensagem com o id ${String(messageId)}.`,
        404,
      );
    }

    request.log.warn(
      { message: messageId, name: message.name, sent: message.sentCount, by: operatorOf(request) },
      'mensagem removida pelo painel',
    );

    return {
      ok: true,
      detail:
        `Mensagem "${message.name}" removida, com ${String(message.sentCount)} envio(s) de ` +
        'histórico. Para calar preservando o histórico, o caminho é desligá-la.',
    };
  });

  /**
   * A ordem da lista, inteira.
   *
   * Recebe a fila COMPLETA, e não "suba esta": com duas telas
   * abertas, um "mova para cima" de cada uma produz uma ordem que
   * ninguém pediu. É a mesma disciplina do `reorder` da fila de
   * mapas (Docs/16 §13).
   */
  app.post('/messages/reorder', async (request) => {
    const { ids } = reorderBody.parse(request.body);

    deps.repository.reorder(ids);

    return { ok: true, messages: deps.repository.list().map(toApi) };
  });

  /**
   * Manda AGORA, sem mexer no `next_at`.
   *
   * ####  TESTAR NÃO PODE ADIAR  ####
   *
   * Se o teste consumisse o horário, conferir a mensagem seria
   * mudá-la — e o admin que clicasse duas vezes empurraria a
   * próxima saída para daqui a uma hora sem saber.
   *
   * A resposta traz o TEXTO JÁ RESOLVIDO por servidor: é o que
   * responde "o `{wipe.faltam}` está pegando?" sem precisar entrar
   * no jogo.
   */
  app.post('/messages/:messageId/test', async (request) => {
    const { messageId } = idParams.parse(request.params);
    const { serverId } = testBody.parse(request.body ?? {});
    const message = deps.repository.get(messageId);

    if (message === null) {
      throw new ApiError(
        'MESSAGE_NOT_FOUND',
        `Não existe mensagem com o id ${String(messageId)}.`,
        404,
      );
    }

    if (serverId !== undefined) {
      assertServers(deps, [serverId]);
    }

    const reports = await deps.service.test(message, serverId);

    if (reports.length === 0) {
      throw new ApiError(
        'MESSAGE_NO_TARGET',
        `A mensagem "${message.name}" não tem servidor nenhum para sair: a lista de alvos aponta ` +
          'para servidores que não existem mais, ou não há servidor cadastrado.',
        409,
      );
    }

    const delivered = reports.filter((report) => report.ok);

    request.log.info(
      { message: messageId, servers: delivered.map((report) => report.serverId), by: operatorOf(request) },
      'mensagem enviada à mão pelo painel (o next_at não foi tocado)',
    );

    return {
      ok: true,
      reports,
      detail:
        delivered.length === 0
          ? `Nada saiu. ${reports[0]?.error ?? ''}`.trim()
          : `Saiu em ${delivered.map((report) => report.serverId).join(', ')}. ` +
            'O horário da próxima saída continua o mesmo.',
    };
  });

  /**
   * "Essa mensagem está mesmo aparecendo?"
   *
   * As linhas que FALHARAM entram aqui também, com o motivo: um log
   * só de sucessos responde "sim" justamente quando a resposta é
   * "não".
   */
  app.get('/messages/:messageId/log', async (request) => {
    const { messageId } = idParams.parse(request.params);
    const { limit } = logQuery.parse(request.query);

    if (deps.repository.get(messageId) === null) {
      throw new ApiError(
        'MESSAGE_NOT_FOUND',
        `Não existe mensagem com o id ${String(messageId)}.`,
        404,
      );
    }

    const entries = deps.service.logOf(messageId, limit ?? DEFAULT_LOG_LIMIT);

    return {
      ok: true,
      entries: entries.map((entry) => ({
        id: entry.id,
        serverId: entry.serverId,
        at: new Date(entry.at).toISOString(),
        players: entry.players,
        ok: entry.ok,
        error: entry.error,
      })),
    };
  });

  /**
   * Uma fala avulsa, pelo MESMO transporte das agendadas.
   *
   * É por aqui que um site externo, ou um plugin, faz o servidor
   * falar. Uma segunda forma de mandar texto ao chat é o que o
   * Docs/17 §10 proíbe — e é por isso que esta rota não monta
   * comando nenhum: ela chama o `Broadcaster`.
   */
  app.post('/chat/broadcast', async (request) => {
    const body = broadcastBody.parse(request.body);

    assertServers(deps, [body.serverId]);

    const result = await deps.service.speak(body);

    return {
      ok: true,
      ...result,
      detail:
        result.via === 'plugin'
          ? `Falou para ${String(result.sent)} jogador(es) em ${body.serverId}.`
          : `Falou em ${body.serverId} pelo say do jogo (sem cor): o OrigemZChat não respondeu. ` +
            'O jogo não diz quantos receberam.',
    };
  });
}

// ------------------------------------------------------------
//  Conferências
// ------------------------------------------------------------

/**
 * O PATCH parcial vira o registro inteiro.
 *
 * Escrita à mão, campo a campo, e não com um spread: o spread
 * aceitaria `undefined` como valor e apagaria em silêncio o que
 * não veio no corpo — que é a diferença entre PATCH e PUT.
 */
function mergeInput(current: MessageView, patch: z.infer<typeof patchBody>): MessageInput {
  return {
    name: patch.name ?? current.name,
    text: patch.text ?? current.text,
    enabled: patch.enabled ?? current.enabled,
    scheduleKind: patch.scheduleKind ?? current.scheduleKind,
    everySeconds: patch.everySeconds === undefined ? current.everySeconds : patch.everySeconds,
    timeOfDay: patch.timeOfDay === undefined ? current.timeOfDay : patch.timeOfDay,
    weekdays: patch.weekdays ?? current.weekdays,
    runAt: patch.runAt === undefined ? current.runAt : patch.runAt,
    timeZone: patch.timeZone ?? current.timeZone,
    windowFrom: patch.windowFrom === undefined ? current.windowFrom : patch.windowFrom,
    windowTo: patch.windowTo === undefined ? current.windowTo : patch.windowTo,
    onlyWithPlayers: patch.onlyWithPlayers ?? current.onlyWithPlayers,
    minPlayers: patch.minPlayers ?? current.minPlayers,
    tag: patch.tag === undefined ? current.tag : patch.tag,
    tagColor: patch.tagColor === undefined ? current.tagColor : patch.tagColor,
    color: patch.color === undefined ? current.color : patch.color,
    size: patch.size === undefined ? current.size : patch.size,
    targets: patch.targets ?? current.targets,
  };
}

/**
 * O `next_at` depois de uma edição.
 *
 * ####  CONSERTAR UMA VÍRGULA NÃO PODE ZERAR O RELÓGIO  ####
 *
 * Recalcular sempre pareceria mais simples e teria um efeito
 * concreto: quem corrigisse um erro de digitação numa mensagem de
 * meia em meia hora empurraria a próxima saída para daqui a meia
 * hora — e, corrigindo três vezes, calaria a mensagem por uma hora
 * e meia sem entender por quê.
 *
 * Então só recalcula quem mexeu no RITMO. E ao RELIGAR, sempre:
 * uma mensagem desligada há semanas tem um horário de semanas
 * atrás, e ele sairia na volta seguinte, sem ninguém pedir.
 */
function nextAtAfterEdit(
  deps: MessageRoutesDeps,
  current: MessageView,
  merged: MessageInput,
): number | null {
  if (!merged.enabled) {
    return null;
  }

  return keepsNextAt(current, merged) ? current.nextAt : deps.service.nextAtFor(merged, true);
}

/**
 * O horário gravado continua valendo depois desta edição?
 *
 * Pura e exportada porque é a regra que o teste cobre: "corrigir o
 * texto não adia a próxima saída, e trocar o ritmo adia".
 */
export function keepsNextAt(current: MessageView, merged: MessageInput): boolean {
  // Religar SEMPRE recalcula: uma mensagem desligada há semanas tem
  // um horário de semanas atrás, e ele sairia na volta seguinte.
  if (!current.enabled || current.nextAt === null) {
    return false;
  }

  const sameWeekdays =
    current.weekdays.join(',') === [...merged.weekdays].sort((a, b) => a - b).join(',');

  return (
    current.scheduleKind === merged.scheduleKind &&
    current.everySeconds === merged.everySeconds &&
    current.timeOfDay === merged.timeOfDay &&
    current.runAt === merged.runAt &&
    current.timeZone === merged.timeZone &&
    sameWeekdays
  );
}

/**
 * As quatro formas de ritmo ficam honestas aqui.
 *
 * Cada uma delas é um pedido que o BANCO aceitaria (as colunas são
 * anuláveis) e que o admin descobriria como "a mensagem nunca
 * sai" — o pior defeito possível numa mensagem, porque não parece
 * defeito.
 *
 * @throws {ApiError} 422, com a frase que diz o que preencher.
 */
function assertCoherent(input: MessageInput): void {
  const refuse = (message: string): never => {
    throw new ApiError('MESSAGE_INVALID_SCHEDULE', message, 422);
  };

  if (input.scheduleKind === 'interval' && input.everySeconds === null) {
    refuse(
      'Uma mensagem "a cada N" precisa do intervalo, em segundos. Sem ele ela ficaria na lista ' +
        'sem sair nunca.',
    );
  }

  if (
    (input.scheduleKind === 'daily' || input.scheduleKind === 'weekly') &&
    input.timeOfDay === null
  ) {
    refuse('Uma mensagem diária ou semanal precisa do horário, em HH:MM.');
  }

  if (input.scheduleKind === 'weekly' && input.weekdays.length === 0) {
    refuse(
      'Uma mensagem semanal precisa de pelo menos um dia da semana marcado (0 = domingo). Sem ' +
        'nenhum, ela não teria quando sair.',
    );
  }

  if (input.scheduleKind === 'once' && input.runAt === null) {
    refuse('Uma mensagem de uma vez só precisa da data e da hora em que ela sai.');
  }

  // ####  A JANELA É UM PAR, E NÃO DOIS CAMPOS  ####
  //
  // Um lado só preenchido é configuração pela metade, e o motor a
  // trata como "a qualquer hora". Recusar aqui é o que faz o admin
  // descobrir isso na hora de gravar, e não semanas depois olhando
  // o log.
  if ((input.windowFrom === null) !== (input.windowTo === null)) {
    refuse(
      'A janela de horário tem dois lados: preencha os dois ("das 10:00 às 23:00"), ou deixe os ' +
        'dois em branco para a mensagem sair a qualquer hora.',
    );
  }

  // ####  O HORÁRIO MARCADO NÃO PODE ESTAR FORA DA JANELA  ####
  //
  // "Todo dia às 03:00, mas só entre 10:00 e 23:00" é uma mensagem
  // que nunca sai. O motor está certo em não a mandar; quem
  // precisa saber é quem digitou.
  if (
    (input.scheduleKind === 'daily' || input.scheduleKind === 'weekly') &&
    input.timeOfDay !== null &&
    input.windowFrom !== null &&
    input.windowTo !== null
  ) {
    const at = parseMinutesOfDay(input.timeOfDay);
    const from = parseMinutesOfDay(input.windowFrom);
    const to = parseMinutesOfDay(input.windowTo);

    if (at !== null && from !== null && to !== null && from !== to) {
      // A janela pode virar a meia-noite: `22:00`–`02:00` é a UNIÃO
      // de dois pedaços. Ver messages/schedule.ts.
      const inside = from < to ? at >= from && at < to : at >= from || at < to;

      if (!inside) {
        refuse(
          `O horário ${input.timeOfDay} está fora da janela ${input.windowFrom}–${input.windowTo}: ` +
            'esta mensagem nunca sairia.',
        );
      }
    }
  }
}

/**
 * @throws {ApiError} 422 quando a zona não existe neste runtime.
 *
 * A conferência é na BORDA, e não no motor: uma zona inválida
 * gravada faria a mensagem falhar de madrugada, longe de quem a
 * digitou.
 */
function assertTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new ApiError(
      'MESSAGE_INVALID_TIMEZONE',
      `"${timeZone}" não é uma zona conhecida. Use o nome IANA, como America/Sao_Paulo.`,
      422,
    );
  }
}

/**
 * @throws {ApiError} 404 quando um dos ids não existe.
 *
 * Uma mensagem apontando para um servidor que não existe é uma
 * mensagem que não sai em lugar nenhum — e como a lista VAZIA quer
 * dizer "todos", ela seria indistinguível de uma bem configurada
 * na tela.
 */
function assertServers(deps: MessageRoutesDeps, servers: readonly string[]): void {
  const known = new Set(deps.supervisor.ids());
  const missing = servers.filter((id) => !known.has(id));

  if (missing.length > 0) {
    throw new ApiError(
      'SERVER_NOT_FOUND',
      `Não existe servidor com o id ${missing.map((id) => `"${id}"`).join(', ')}.`,
      404,
    );
  }
}

/**
 * A visão do banco vira a da API: epoch ms vira ISO na borda.
 *
 * É a convenção do projeto inteiro (ver kits/service.ts): o banco
 * guarda número, a API fala ISO, e a tela formata. Uma data em
 * milissegundos no JSON obrigaria cada consumidor a saber a unidade.
 */
function toApi(message: MessageView): Record<string, unknown> {
  return {
    id: message.id,
    name: message.name,
    text: message.text,
    enabled: message.enabled,
    position: message.position,
    scheduleKind: message.scheduleKind,
    everySeconds: message.everySeconds,
    timeOfDay: message.timeOfDay,
    weekdays: message.weekdays,
    runAt: message.runAt === null ? null : new Date(message.runAt).toISOString(),
    timeZone: message.timeZone,
    windowFrom: message.windowFrom,
    windowTo: message.windowTo,
    onlyWithPlayers: message.onlyWithPlayers,
    minPlayers: message.minPlayers,
    tag: message.tag,
    tagColor: message.tagColor,
    color: message.color,
    size: message.size,
    lastSentAt: message.lastSentAt === null ? null : new Date(message.lastSentAt).toISOString(),
    nextAt: message.nextAt === null ? null : new Date(message.nextAt).toISOString(),
    sentCount: message.sentCount,
    targets: message.targets,
    /** A frase pronta da coluna REPETE. Ver messages/schedule.ts. */
    schedule: describeSchedule(message),
    createdAt: new Date(message.createdAt).toISOString(),
    updatedAt: new Date(message.updatedAt).toISOString(),
  };
}
