// ============================================================
//  routes/ui.ts  -  as interfaces do jogo.
//
//      GET    /api/ui/documents                 a lista
//      POST   /api/ui/documents                 cria
//      GET    /api/ui/documents/:id             o documento inteiro
//      PUT    /api/ui/documents/:id             grava (sobe a revisão)
//      DELETE /api/ui/documents/:id             remove
//      POST   /api/ui/documents/:id/preview     modelo -> CuiElement
//
//      GET    /api/servers/:id/ui               o que este servidor usa
//      PUT    /api/servers/:id/ui               escolhe e esconde
//      POST   /api/servers/:id/ui/push          empurra agora
//
//  ####  O DESENHO É DA REDE; O QUE APARECE É DO SERVIDOR  ####
//
//  Por isso as rotas são duas famílias. As de `/ui/documents`
//  mexem no desenho, que vale para todo mundo; as de
//  `/servers/:id/ui` mexem só no que AQUELE servidor mostra.
//
//  ####  O PREVIEW NÃO TOCA EM SERVIDOR NENHUM  ####
//
//  Ele converte modelo em `CuiElement` e devolve. É o que dá ao
//  editor uma resposta sobre a conversão que VALE — a do painel é
//  um espelho, e espelhos divergem. E é o que permite conferir uma
//  tela com o jogo inteiro parado.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type {
  ServerUiBinding,
  StoredUiDocument,
  UiDocumentsRepository,
} from '../../db/ui-documents-repository.js';
import { screenToCui } from '../../game/ui-cui.js';
import { UI_PRESETS } from '../../game/ui-preset-main-menu.js';
import type { UiSync } from '../../game/ui-sync.js';
import {
  applyHidden,
  findDocumentProblems,
  uiDocumentSchema,
  MAX_DOCUMENT_BYTES,
  type UiDocument,
} from '../../types/ui-document.js';
import {
  encodeUiDocPayload,
  toDocumentPayload,
  UI_DOC_MAX_BYTES,
} from '../../types/ui-transport.js';
import { ApiError } from '../error-response.js';

export interface UiRoutesDeps {
  readonly repository: UiDocumentsRepository;
  readonly sync: UiSync;
  /**
   * Os servidores que existem.
   *
   * Serve para uma coisa só: recusar uma configuração de interface
   * para um id que não existe, com a frase certa. Sem isto, a
   * chave estrangeira estouraria como erro 500.
   */
  readonly servers: { ids(): readonly string[] };
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });

/**
 * O corpo de criação: um documento pronto OU um modelo.
 *
 * ####  O PRESET É RESOLVIDO AQUI, E NÃO NO PAINEL  ####
 *
 * O Menu Principal é o mesmo documento que o agente cria sozinho
 * no primeiro boot (ver index.ts). Tê-lo num lugar só é o que
 * impede "criei pelo botão" e "nasceu no boot" de darem menus
 * diferentes — e é o que permite ao teste medir o tamanho da carga
 * do preset que de fato vai ao jogo.
 */
const createBody = z.object({
  document: z.unknown().optional(),
  preset: z.string().min(1).max(64).optional(),
});
const updateBody = z.object({ document: z.unknown() });

const previewBody = z.object({
  /** Qual tela desenhar. Ausente = a de entrada. */
  screenId: z.string().optional(),
  /**
   * Converter como ESTE servidor veria.
   *
   * Sem ele, o preview mostra o documento cru — que é o que o
   * editor quer enquanto desenha. Com ele, mostra o que aquele
   * servidor de fato desenha, com os pedaços escondidos fora.
   */
  serverId: z.string().optional(),
  /**
   * O documento a converter, se ainda não foi salvo.
   *
   * É o que permite ao editor conferir a conversão ANTES de
   * gravar — que é justamente quando o erro é barato de corrigir.
   * Ausente = o documento que está no banco.
   */
  document: z.unknown().optional(),
});

const bindingBody = z.object({
  /** `null` = este servidor não usa menu nenhum. */
  documentId: z.number().int().positive().nullable(),
  enabled: z.boolean().default(true),
  hidden: z.array(z.string().min(1).max(64)).max(500).default([]),
});

export function registerUiRoutes(app: FastifyInstance, deps: UiRoutesDeps): void {
  // ------------------------------------------------------
  //  Os documentos — o desenho, que é da rede
  // ------------------------------------------------------

  app.get('/ui/documents', async () => {
    return {
      ok: true,
      documents: deps.repository.list().map((summary) => ({
        ...summary,
        createdAt: new Date(summary.createdAt).toISOString(),
        updatedAt: new Date(summary.updatedAt).toISOString(),
        servers: summary.servers.map(toBindingBody),
      })),
    };
  });

  /** Os modelos que a tela pode oferecer em "Criar a partir do modelo". */
  app.get('/ui/presets', async () => {
    return { ok: true, presets: Object.keys(UI_PRESETS) };
  });

  app.post('/ui/documents', async (request, reply) => {
    const body = createBody.parse(request.body);
    const parsed = parseDocument(fromPresetOrBody(body));

    if (deps.repository.getBySlug(parsed.id) !== null) {
      throw new ApiError(
        'UI_DOCUMENT_EXISTS',
        `Já existe uma interface com o identificador "${parsed.id}". Ele é o endereço que o ` +
          'plugin usa para achar o menu — dois iguais fariam um esconder o outro.',
        409,
      );
    }

    const created = deps.repository.create(parsed);

    // Um documento novo só chega ao jogo depois de algum servidor
    // escolhê-lo. Nada a empurrar aqui, de propósito.
    return reply.status(201).send({ ok: true, document: toDocumentBody(created) });
  });

  app.get('/ui/documents/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    return { ok: true, document: toDocumentBody(mustGet(deps, id)) };
  });

  /**
   * Grava o documento inteiro e sobe a revisão.
   *
   * ####  O ENVIO É DISPARADO AQUI, E NÃO ESPERADO  ####
   *
   * Quem salva no editor não pode ficar esperando N servidores
   * responderem pelo RCON — e um deles estar parado não é motivo
   * para a gravação falhar. A resposta é o documento salvo; o
   * envio sai em seguida, e o que aconteceu com ele aparece na
   * revisão aplicada de cada servidor.
   */
  app.put('/ui/documents/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { document } = updateBody.parse(request.body);

    const existing = mustGet(deps, id);
    const parsed = parseDocument(document);

    if (parsed.id !== existing.slug) {
      throw new ApiError(
        'UI_DOCUMENT_ID_MISMATCH',
        `Este documento é o "${existing.slug}" e o que chegou diz ser "${parsed.id}". O ` +
          'identificador é o endereço que o plugin guarda e que os botões carregam — trocá-lo ' +
          'numa edição quebraria toda referência a ele, em silêncio.',
        409,
      );
    }

    const saved = deps.repository.update(id, parsed);

    if (saved === null) {
      throw new ApiError('UI_DOCUMENT_NOT_FOUND', `A interface ${String(id)} não existe.`, 404);
    }

    deps.sync.pushAllSoon('documento-salvo');

    return { ok: true, document: toDocumentBody(saved) };
  });

  app.delete('/ui/documents/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    if (!deps.repository.remove(id)) {
      throw new ApiError('UI_DOCUMENT_NOT_FOUND', `A interface ${String(id)} não existe.`, 404);
    }

    // Os servidores que a usavam precisam saber: a linha de
    // `server_ui` sumiu na cascata, e sem um envio novo o menu
    // continuaria no cache do plugin até o próximo reload.
    deps.sync.pushAllSoon('documento-removido');

    return { ok: true };
  });

  /**
   * Modelo -> `CuiElement`, sem tocar em servidor nenhum.
   *
   * Devolve TAMBÉM o tamanho da carga inicial, porque é a pergunta
   * que o editor precisa responder antes de o menu chegar ao jogo:
   * passando do teto do RCON o envio é recusado inteiro, e
   * descobrir isso na hora do push é tarde.
   */
  app.post('/ui/documents/:id/preview', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = previewBody.parse(request.body ?? {});

    // O documento do corpo ganha do gravado: é o que permite
    // conferir uma edição que ainda não foi salva.
    const document =
      body.document === undefined ? mustGet(deps, id).document : parseDocument(body.document);

    const hidden =
      body.serverId === undefined
        ? []
        : (deps.repository.bindingsOf(body.serverId).find((binding) => binding.documentId === id)
            ?.hidden ?? []);

    const view = applyHidden(document, hidden);
    const screenId = body.screenId ?? view.entryScreenId;
    const screen = view.screens.find((item) => item.id === screenId);

    if (screen === undefined) {
      throw new ApiError(
        'UI_SCREEN_NOT_FOUND',
        `A tela "${screenId}" não existe neste documento` +
          (hidden.length > 0 ? ' — ou está escondida neste servidor.' : '.'),
        404,
      );
    }

    const bytes = encodeUiDocPayload({ documents: [toDocumentPayload(view)] }).length;

    return {
      ok: true,
      screen: { id: screen.id, name: screen.name, kind: screen.kind },
      cui: screenToCui(view, screen),
      // O tamanho da CARGA INICIAL deste documento, em base64 — e
      // não o desta tela. O que viaja no `origemz.ui.doc` são os
      // metadados mais a tela de ENTRADA, e é esse número que bate
      // no teto.
      payload: { bytes, limit: UI_DOC_MAX_BYTES, fits: bytes <= UI_DOC_MAX_BYTES },
    };
  });

  // ------------------------------------------------------
  //  Por servidor — o que ele usa, e o que esconde
  // ------------------------------------------------------

  app.get('/servers/:id/ui', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const bindings = deps.repository.bindingsOf(id);
    const first = bindings[0];

    return {
      ok: true,
      // A ligação deste servidor. `null` = ele não usa menu nenhum.
      //
      // Uma só: o plugin registra o comando de chat de cada
      // documento, e a tela de Configurações escolhe UM menu.
      binding: first === undefined ? null : toBindingBody(first),
      // As interfaces que existem, para a tela oferecer a escolha.
      documents: deps.repository.list().map((summary) => ({
        id: summary.id,
        slug: summary.slug,
        name: summary.name,
        command: summary.command,
        revision: summary.revision,
        screens: summary.screens,
      })),
    };
  });

  /**
   * Escolhe o menu deste servidor e o que ele esconde.
   *
   * `documentId: null` desfaz a escolha. O envio seguinte manda uma
   * carga VAZIA, que é o que tira o menu do jogo — deixar de mandar
   * não tiraria: o plugin continuaria com o cache dele.
   */
  app.put('/servers/:id/ui', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = bindingBody.parse(request.body);

    assertServer(deps, id);

    if (body.documentId === null) {
      deps.repository.clearBindings(id);
      deps.sync.pushSoon(id, 'configuração');

      return { ok: true, binding: null };
    }

    if (deps.repository.get(body.documentId) === null) {
      throw new ApiError(
        'UI_DOCUMENT_NOT_FOUND',
        `A interface ${String(body.documentId)} não existe.`,
        404,
      );
    }

    // Um servidor usa UM menu: a escolha nova substitui a anterior.
    // Sem isto, trocar de menu deixaria os dois ligados, e o plugin
    // registraria os comandos de chat dos dois.
    deps.repository.clearBindings(id);

    const binding = deps.repository.setBinding(id, body.documentId, {
      enabled: body.enabled,
      hidden: body.hidden,
    });

    deps.sync.pushSoon(id, 'configuração');

    return { ok: true, binding: toBindingBody(binding) };
  });

  /**
   * Empurra agora, e diz o que aconteceu.
   *
   * Ao contrário do envio disparado por uma edição, este é
   * SÍNCRONO: quem clicou está olhando, e a diferença entre
   * "servidor parado", "carga acima do teto" e "o RCON recusou" é
   * exatamente o que ele precisa ler.
   */
  app.post('/servers/:id/ui/push', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const outcome = await deps.sync.push(id, 'manual');

    if (outcome.status === 'skipped') {
      throw new ApiError('RCON_UNAVAILABLE', outcome.reason, 503);
    }

    if (outcome.status === 'refused') {
      throw new ApiError('UI_PAYLOAD_TOO_LARGE', outcome.reason, 413);
    }

    if (outcome.status === 'failed') {
      throw new ApiError(
        'UI_PUSH_FAILED',
        `O servidor não aceitou a interface: ${outcome.reason}`,
        502,
      );
    }

    return { ok: true, documents: outcome.documents, bytes: outcome.bytes };
  });
}

/**
 * O documento do corpo, ou o modelo pedido.
 *
 * Os dois juntos é ambíguo, e a ambiguidade aqui custa caro: o
 * documento seria ignorado em silêncio e alguém acharia que salvou
 * o desenho dele.
 *
 * @throws {ApiError} 400 nos dois casos degenerados, 404 no modelo
 * que não existe.
 */
function fromPresetOrBody(body: {
  readonly document?: unknown;
  readonly preset?: string | undefined;
}): unknown {
  if (body.preset !== undefined && body.document !== undefined) {
    throw new ApiError(
      'UI_DOCUMENT_AMBIGUOUS',
      'Mande um documento OU um modelo, nunca os dois: com os dois, um dos desenhos seria ' +
        'descartado sem ninguém ver qual.',
      400,
    );
  }

  if (body.preset === undefined) {
    if (body.document === undefined) {
      throw new ApiError(
        'UI_DOCUMENT_MISSING',
        'Nenhum documento e nenhum modelo. Uma interface em branco não tem tela de entrada, e o ' +
          `menu não abriria — comece por um modelo: ${Object.keys(UI_PRESETS).join(', ')}.`,
        400,
      );
    }

    return body.document;
  }

  const preset = UI_PRESETS[body.preset];

  if (preset === undefined) {
    throw new ApiError(
      'UI_PRESET_NOT_FOUND',
      `Não existe modelo "${body.preset}". Os que existem: ${Object.keys(UI_PRESETS).join(', ')}.`,
      404,
    );
  }

  return preset();
}

/**
 * O corpo -> documento validado.
 *
 * Duas checagens, e as duas precisam existir: o schema pega campo
 * fora de forma, e `findDocumentProblems` pega o que só o
 * documento INTEIRO revela — botão que navega para tela apagada,
 * id repetido, árvore funda demais.
 *
 * @throws {ApiError} 400 com todos os problemas de uma vez: quem
 * manda um documento por script quer a lista inteira, não uma ida
 * e volta por erro.
 */
function parseDocument(raw: unknown): UiDocument {
  const size = JSON.stringify(raw ?? null).length;

  if (size > MAX_DOCUMENT_BYTES) {
    throw new ApiError(
      'UI_DOCUMENT_TOO_LARGE',
      `Este documento tem ${String(size)} bytes, acima do teto de ` +
        `${String(MAX_DOCUMENT_BYTES)}. O teto protege o banco e a memória do agente — uma ` +
        'interface desse tamanho também não caberia no jogo.',
      413,
    );
  }

  // O zod lança `ZodError`, e o error handler do Fastify já o
  // traduz em 400 com o caminho de cada campo. Não há por que
  // repetir isso aqui.
  const document = uiDocumentSchema.parse(raw);
  const problems = findDocumentProblems(document);

  if (problems.length > 0) {
    throw new ApiError(
      'UI_DOCUMENT_INVALID',
      problems.map((problem) => problem.message).join(' '),
      400,
    );
  }

  return document;
}

function mustGet(deps: UiRoutesDeps, id: number): StoredUiDocument {
  const stored = deps.repository.get(id);

  if (stored === null) {
    throw new ApiError(
      'UI_DOCUMENT_NOT_FOUND',
      `A interface ${String(id)} não existe — ou o JSON dela está ilegível no banco, e o agente ` +
        'recusa servir um desenho que não passa no próprio modelo. O log do processo diz qual ' +
        'dos dois.',
      404,
    );
  }

  return stored;
}

function assertServer(deps: UiRoutesDeps, id: string): void {
  if (!deps.servers.ids().includes(id)) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
        `${deps.servers.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}

/** Um documento, na forma que a API entrega. Datas em ISO. */
function toDocumentBody(stored: StoredUiDocument): {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly revision: number;
  readonly document: UiDocument;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    id: stored.id,
    slug: stored.slug,
    name: stored.name,
    revision: stored.revision,
    document: stored.document,
    createdAt: new Date(stored.createdAt).toISOString(),
    updatedAt: new Date(stored.updatedAt).toISOString(),
  };
}

function toBindingBody(binding: ServerUiBinding): {
  readonly serverId: string;
  readonly documentId: number;
  readonly enabled: boolean;
  readonly hidden: readonly string[];
  readonly appliedRevision: number | null;
  readonly appliedAt: string | null;
} {
  return {
    serverId: binding.serverId,
    documentId: binding.documentId,
    enabled: binding.enabled,
    hidden: binding.hidden,
    appliedRevision: binding.appliedRevision,
    appliedAt: binding.appliedAt === null ? null : new Date(binding.appliedAt).toISOString(),
  };
}
