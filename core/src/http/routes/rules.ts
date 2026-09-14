// ============================================================
//  routes/rules.ts  -  as regras que o jogador lê no /menu.
//
//  Duas famílias, porque são dois assuntos:
//
//      /api/rules                 o conjunto da REDE
//      /api/rules/servers/:id     o daquele servidor, e de onde
//                                 ele lê
//
//  ####  O ESCOPO VIAJA NO CORPO, E É SEMPRE EXPLÍCITO  ####
//
//  `server: null` é a rede; `server: "server01"` é o conjunto
//  próprio daquele servidor. Nunca é deduzido de quem está logado
//  nem do último escopo aberto: uma regra gravada no lugar errado
//  só aparece quando alguém abre o jogo, e aí já está publicada.
//
//  ####  MUDAR REGRA NÃO EMPURRA NADA  ####
//
//  A tela do jogo é montada a cada clique e vai marcada como
//  volátil (ver ui-rules-screen.ts), então o texto novo vale no
//  clique seguinte, em todos os servidores, sem sincronizar
//  documento nenhum.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RulesRepository } from '../../db/rules-repository.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ruleItemInputSchema, ruleSectionInputSchema, RULES_SCOPE_MODES } from '../../types/rules.js';
import { ApiError } from '../error-response.js';

export interface RuleRoutesDeps {
  readonly rules: RulesRepository;
  readonly supervisor: ServerSupervisor;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });

/**
 * O escopo, como ele chega.
 *
 * Ausente e `null` querem dizer a mesma coisa — a rede —, e é o
 * que faz o painel poder mandar sempre o campo, com o valor que
 * ele tem na tela.
 */
const scopeField = z.string().min(1).nullish();

const sectionBody = ruleSectionInputSchema.extend({ server: scopeField }).strict();
const reorderBody = z.object({ server: scopeField, ids: z.array(z.number().int()) }).strict();
const itemReorderBody = z.object({ ids: z.array(z.number().int()) }).strict();
const modeBody = z.object({ mode: z.enum(RULES_SCOPE_MODES) }).strict();

export function registerRuleRoutes(app: FastifyInstance, deps: RuleRoutesDeps): void {
  /** O servidor existe? Escopo inventado gravaria regra invisível. */
  const scopeOf = (server: string | null | undefined): string | null => {
    if (server === undefined || server === null) {
      return null;
    }

    if (!deps.supervisor.ids().includes(server)) {
      throw new ApiError('SERVER_NOT_FOUND', `Não conheço o servidor "${server}".`, 404);
    }

    return server;
  };

  // ==========================================================
  //  O conjunto da rede
  // ==========================================================

  app.get('/rules', async () => ({
    ok: true,
    sections: deps.rules.sections(null),
    // Os ids servem à tela: escolher o servidor cujo conjunto se
    // quer ver sem ter de adivinhar como ele se chama.
    servers: deps.supervisor.ids(),
  }));

  // ==========================================================
  //  O conjunto de um servidor
  // ==========================================================

  /**
   * O que ESTE servidor mostra, e de onde.
   *
   * Vem com as duas listas: a que vale (`sections`) e a PRÓPRIA
   * dele (`own`). São diferentes quando ele herda, e a tela precisa
   * das duas para poder dizer "isto aqui é da rede" sem uma segunda
   * ida ao agente.
   */
  app.get('/rules/servers/:id', async (request) => {
    const { id } = serverParams.parse(request.params);
    const server = scopeOf(id);

    return {
      ok: true,
      server: id,
      mode: deps.rules.modeOf(id),
      sections: deps.rules.viewFor(id).sections,
      own: deps.rules.sections(server),
    };
  });

  app.put('/rules/servers/:id/mode', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { mode } = modeBody.parse(request.body);

    scopeOf(id);
    deps.rules.setMode(id, mode);

    return { ok: true, mode, sections: deps.rules.viewFor(id).sections };
  });

  /**
   * Começar o conjunto próprio a partir do da rede.
   *
   * ####  ELE ACRESCENTA, E NÃO SUBSTITUI  ####
   *
   * Copiar por cima apagaria, sem confirmação, o que o admin já
   * tivesse escrito naquele servidor. Quem quer trocar apaga antes
   * — e apagar é uma ação que precisa ser dele.
   */
  app.post('/rules/servers/:id/copy', async (request) => {
    const { id } = serverParams.parse(request.params);

    scopeOf(id);

    const copied = deps.rules.copySections(null, id);

    return { ok: true, copied, own: deps.rules.sections(id) };
  });

  // ==========================================================
  //  As seções
  // ==========================================================

  app.post('/rules/sections', async (request, reply) => {
    const body = sectionBody.parse(request.body);
    const scope = scopeOf(body.server);

    const id = deps.rules.createSection(scope, { title: body.title, enabled: body.enabled });

    void reply.code(201);

    return { ok: true, id, sections: deps.rules.sections(scope) };
  });

  app.patch('/rules/sections/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = sectionBody.parse(request.body);

    if (!deps.rules.updateSection(id, { title: body.title, enabled: body.enabled })) {
      throw new ApiError('SECTION_NOT_FOUND', 'Esta seção não existe mais.', 404);
    }

    return { ok: true, sections: deps.rules.sections(sectionScope(deps, id)) };
  });

  app.delete('/rules/sections/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    // O escopo é lido ANTES de apagar: depois não há linha de onde
    // tirá-lo, e a resposta precisa devolver a lista que sobrou.
    const scope = sectionScope(deps, id);

    if (!deps.rules.deleteSection(id)) {
      throw new ApiError('SECTION_NOT_FOUND', 'Esta seção não existe mais.', 404);
    }

    return { ok: true, sections: deps.rules.sections(scope) };
  });

  app.post('/rules/sections/reorder', async (request) => {
    const body = reorderBody.parse(request.body);
    const scope = scopeOf(body.server);

    deps.rules.reorderSections(scope, body.ids);

    return { ok: true, sections: deps.rules.sections(scope) };
  });

  /**
   * Escreve o modelo de fábrica.
   *
   * Só num escopo VAZIO: rodá-lo duas vezes duplicaria as quatro
   * seções, e o admin descobriria isso no jogo.
   */
  app.post('/rules/template', async (request) => {
    const { server } = z.object({ server: scopeField }).strict().parse(request.body ?? {});
    const scope = scopeOf(server);

    if (deps.rules.sections(scope).length > 0) {
      throw new ApiError(
        'RULES_NOT_EMPTY',
        'Este conjunto já tem seções. O modelo só entra num conjunto vazio.',
        409,
      );
    }

    deps.rules.seedTemplate(scope);

    return { ok: true, sections: deps.rules.sections(scope) };
  });

  // ==========================================================
  //  As regras dentro de uma seção
  // ==========================================================

  app.post('/rules/sections/:id/items', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = ruleItemInputSchema.parse(request.body);
    const scope = sectionScope(deps, id);

    deps.rules.createItem(id, body);
    void reply.code(201);

    return { ok: true, sections: deps.rules.sections(scope) };
  });

  app.post('/rules/sections/:id/items/reorder', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = itemReorderBody.parse(request.body);
    const scope = sectionScope(deps, id);

    deps.rules.reorderItems(id, body.ids);

    return { ok: true, sections: deps.rules.sections(scope) };
  });

  app.patch('/rules/items/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = ruleItemInputSchema.parse(request.body);

    if (!deps.rules.updateItem(id, body)) {
      throw new ApiError('RULE_NOT_FOUND', 'Esta regra não existe mais.', 404);
    }

    return { ok: true };
  });

  app.delete('/rules/items/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    if (!deps.rules.deleteItem(id)) {
      throw new ApiError('RULE_NOT_FOUND', 'Esta regra não existe mais.', 404);
    }

    return { ok: true };
  });
}

/**
 * De quem é a seção.
 *
 * Uma seção que não existe mais é um 404 aqui, e não um escopo
 * `null` — sem isto, editar uma seção apagada responderia com a
 * lista da REDE, e o admin acharia que o conjunto dele evaporou.
 */
function sectionScope(deps: RuleRoutesDeps, id: number): string | null {
  const scope = deps.rules.scopeOfSection(id);

  if (scope === undefined) {
    throw new ApiError('SECTION_NOT_FOUND', 'Esta seção não existe mais.', 404);
  }

  return scope;
}
