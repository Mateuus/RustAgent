// ============================================================
//  routes/dungeons.ts  -  a masmorra e as peças dela.
//
//  Três famílias, e são três assuntos:
//
//      /dungeons             a masmorra: receita ou planta
//      /dungeon-blueprints   o acervo de construções do CopyPaste
//      /dungeon-layouts      o acervo de traçados desenhados
//
//  Os dois acervos parecem o mesmo e não são: um guarda peças com
//  posição, que o plugin COLA; o outro guarda células, que o
//  plugin CONSTRÓI. Ver `dungeons/layout.ts`.
//
//  ####  A LISTA DE PLANTAS NUNCA DEVOLVE O `content`  ####
//
//  As sete que vêm com o projeto somam 1,1 MB, e a maior sozinha
//  tem 512 KB. Uma listagem que carregasse tudo faria o painel
//  baixar isso a cada abertura de tela — para mostrar sete nomes.
//
//  ####  A REGRA MORA NO TIPO; AQUI É SÓ A BORDA  ####
//
//  `types/dungeons.ts` é a régua: modo, cor, porta, os limites de
//  cada número e as duas regras que só se enxergam com o objeto
//  inteiro. Esta rota valida com ELA, chama o repositório e traduz
//  a resposta. Um `z.object` equivalente aqui seria uma segunda
//  régua para a mesma tabela — e a que ficar mais frouxa é a que
//  grava.
//
//  ####  AS TRÊS REGRAS QUE NASCEM AQUI  ####
//
//  Elas existem nesta camada porque só a rota tem os dados para
//  vê-las:
//
//    1. `BLUEPRINT_NO_HATCH` — subir uma planta de entrada sem
//       alçapão. Ela pareceria funcionar e falharia 60 segundos
//       depois, no jogo, com a casinha já de pé;
//    2. `BLUEPRINT_IN_USE` — apagar uma planta que uma masmorra
//       usa como entrada;
//    3. `BLUEPRINT_MISSING` — apontar para uma planta que não
//       existe. A masmorra nasceria sem entrada e ninguém
//       entenderia por quê.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §10.2 e §10.3.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { DungeonBlueprintsRepository } from '../../db/dungeon-blueprints-repository.js';
import type { DungeonLayoutsRepository } from '../../db/dungeon-layouts-repository.js';
import type { DungeonsRepository } from '../../db/dungeons-repository.js';
import type { WorldEventsRepository } from '../../db/world-events-repository.js';
import { BLUEPRINT_PROBLEM_MESSAGE } from '../../dungeons/blueprint.js';
import { checkLayout } from '../../dungeons/layout.js';
import { dungeonLayoutInputSchema } from '../../types/dungeon-layouts.js';
import {
  dungeonInputSchema,
  dungeonUpdateSchema,
  FACTORY_RECIPES,
  type DungeonInput,
} from '../../types/dungeons.js';
import { slugSchema } from '../../types/world-events.js';
import { ApiError } from '../error-response.js';

export interface DungeonRoutesDeps {
  readonly dungeons: DungeonsRepository;
  readonly blueprints: DungeonBlueprintsRepository;
  /** O acervo de traçados desenhados. Ver `dungeon-layouts-repository.ts`. */
  readonly layouts: DungeonLayoutsRepository;
  readonly events: WorldEventsRepository;
  /**
   * O jogo precisa saber que algo mudou.
   *
   * ####  E ELE NÃO É ESPERADO  ####
   *
   * A rota responde assim que o BANCO gravou, sem aguardar o RCON.
   * Duas razões: gravar não pode depender de o servidor estar no
   * ar — desenhar masmorra com tudo parado é o caso normal —, e um
   * `await` aqui faria o painel travar cinco segundos por causa de
   * um servidor que não responde.
   *
   * O que chega ao jogo é o estado COMPLETO, então uma chamada
   * perdida se conserta na próxima. Ausente = o agente subiu sem
   * servidores, e a tela funciona igual.
   */
  readonly onChanged?: (reason: string) => void;
}

const idParams = z.object({ id: z.string().min(1) });

/**
 * O filtro do olho do assistente (§12.1.1 do plano).
 *
 * `since` é o momento em que o passo abriu. Sem ele, o painel
 * celebraria a construção de ontem.
 */
const runsQuery = z.object({
  serverId: z.string().min(1).optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const blueprintUploadSchema = z.object({
  id: slugSchema,
  name: z.string().min(1).max(80).optional(),
  kind: z.enum(['entrance', 'base']).default('entrance'),
  content: z.string().min(2),
});

export function registerDungeonRoutes(app: FastifyInstance, deps: DungeonRoutesDeps): void {
  // ==========================================================
  //  AS MASMORRAS
  // ==========================================================

  app.get('/dungeons', async () => ({ ok: true, dungeons: deps.dungeons.list() }));

  /**
   * As quatro receitas de fábrica.
   *
   * Elas NÃO estão no banco: são um modelo do qual o admin parte.
   * Gravá-las na instalação faria "apaguei a fácil" virar "ela
   * volta no próximo boot" — e o botão "começar de um pronto"
   * (§12.6) quer justamente duplicar, não referenciar.
   */
  app.get('/dungeons/factory', async () => ({ ok: true, recipes: FACTORY_RECIPES }));

  app.get('/dungeons/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const dungeon = deps.dungeons.get(id);

    if (dungeon === null) throw notFound(id);

    return { ok: true, dungeon };
  });

  app.post('/dungeons', async (request, reply) => {
    const input = dungeonInputSchema.parse(request.body);

    if (deps.dungeons.exists(input.id)) {
      throw new ApiError(
        'DUNGEON_EXISTS',
        `Já existe uma masmorra com o identificador "${input.id}".`,
        409,
      );
    }

    assertBlueprintExists(deps, input);

    const dungeon = deps.dungeons.save(input);
    deps.onChanged?.('dungeon-created');

    return reply.status(201).send({ ok: true, dungeon });
  });

  app.put('/dungeons/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = dungeonUpdateSchema.parse(request.body);

    if (!deps.dungeons.exists(id)) throw notFound(id);

    const input = { id, ...body } as DungeonInput;
    assertBlueprintExists(deps, input);

    const dungeon = deps.dungeons.save(input);
    deps.onChanged?.('dungeon-updated');

    return { ok: true, dungeon };
  });

  /**
   * Duplica.
   *
   * É o caminho que faz as receitas de fábrica valerem alguma
   * coisa: o admin não encara trinta campos em branco, ele mexe
   * numa que já está balanceada.
   */
  app.post('/dungeons/:id/duplicate', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ id: slugSchema, name: z.string().min(1).max(80) }).parse(request.body);

    const source = deps.dungeons.get(id) ?? factoryRecipe(id);

    if (source === null) throw notFound(id);

    if (deps.dungeons.exists(body.id)) {
      throw new ApiError(
        'DUNGEON_EXISTS',
        `Já existe uma masmorra com o identificador "${body.id}".`,
        409,
      );
    }

    const copy = { ...source, id: body.id, name: body.name } as DungeonInput;

    const dungeon = deps.dungeons.save(copy);
    deps.onChanged?.('dungeon-duplicated');

    return reply.status(201).send({ ok: true, dungeon });
  });

  app.delete('/dungeons/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    if (!deps.dungeons.remove(id)) throw notFound(id);

    deps.onChanged?.('dungeon-removed');

    return { ok: true };
  });

  /**
   * O comando que o admin cola no jogo.
   *
   * A rota existe para que a frase esteja num lugar só. O painel
   * mostra o que ela devolver — e no dia em que o comando mudar,
   * ele muda aqui e no plugin, não em três telas.
   */
  app.get('/dungeons/:id/command', async (request) => {
    const { id } = idParams.parse(request.params);

    if (!deps.dungeons.exists(id)) throw notFound(id);

    return {
      ok: true,
      chat: `/ozdungeon build ${id}`,
      console: `ozdungeon build ${id} <x> <z> [graus]`,
    };
  });

  /**
   * O que aconteceu com esta masmorra — o olho do assistente.
   *
   * Vazio enquanto o admin não colou o comando; uma linha quando
   * ele colou. O painel chama a cada dois segundos, SÓ enquanto o
   * passo ⑥ está aberto, e para no primeiro resultado.
   */
  app.get('/dungeons/:id/runs', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = runsQuery.parse(request.query);

    if (!deps.dungeons.exists(id)) throw notFound(id);

    return {
      ok: true,
      runs: deps.events.runs({
        dungeonId: id,
        serverId: query.serverId,
        since: query.since,
        limit: query.limit,
      }),
    };
  });

  // ==========================================================
  //  AS PLANTAS
  // ==========================================================

  app.get('/dungeon-blueprints', async () => ({
    ok: true,
    blueprints: deps.blueprints.list(),
  }));

  app.get('/dungeon-blueprints/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const blueprint = deps.blueprints.get(id);

    if (blueprint === null) throw blueprintNotFound(id);

    return { ok: true, blueprint };
  });

  app.post('/dungeon-blueprints', async (request, reply) => {
    const body = blueprintUploadSchema.parse(request.body);

    const result = deps.blueprints.save({
      id: body.id,
      name: body.name ?? body.id,
      kind: body.kind,
      content: body.content,
      origin: 'import',
    });

    if (!result.ok) {
      if (result.problem === 'no_hatch') {
        throw new ApiError(
          'BLUEPRINT_NO_HATCH',
          'Esta planta não tem marca de alçapão, e sem ela a masmorra não abre. ' +
            'A marca é um alçapão com fechadura de código 0707, ou um vaso grande ' +
            'com 1 fertilizante no primeiro compartimento e 999 no sexto.',
          422,
        );
      }

      throw new ApiError('BLUEPRINT_INVALID', BLUEPRINT_PROBLEM_MESSAGE[result.problem], 422);
    }

    deps.onChanged?.('blueprint-uploaded');

    return reply.status(201).send({ ok: true, blueprint: result.blueprint });
  });

  app.delete('/dungeon-blueprints/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    const users = deps.dungeons.usersOfBlueprint(id);

    if (users.length > 0) {
      throw new ApiError(
        'BLUEPRINT_IN_USE',
        users.length === 1
          ? `Esta planta é a entrada da masmorra "${users[0] ?? ''}". Troque a entrada dela antes de apagar.`
          : `Esta planta é a entrada de ${users.length} masmorras (${users.join(', ')}). ` +
            'Troque a entrada delas antes de apagar.',
        409,
      );
    }

    if (!deps.blueprints.remove(id)) throw blueprintNotFound(id);

    return { ok: true };
  });

  // ==========================================================
  //  OS TRAÇADOS DESENHADOS
  // ==========================================================

  /**
   * O acervo de desenhos.
   *
   * ####  AQUI A LISTA TRAZ O CONTEÚDO, E ISSO NÃO É INCOERÊNCIA  ####
   *
   * A regra do acervo de plantas — nunca devolver o `content` na
   * lista — existe porque uma planta do CopyPaste tem meio
   * megabyte. Um desenho tem algumas centenas de bytes, e é ele que
   * a tela precisa para mostrar a miniatura de cada traçado.
   *
   * Sem isso, escolher entre oito traçados seria escolher entre
   * oito nomes.
   */
  app.get('/dungeon-layouts', async () => ({ ok: true, layouts: deps.layouts.list() }));

  app.get('/dungeon-layouts/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const layout = deps.layouts.get(id);

    if (layout === null) throw layoutNotFound(id);

    return { ok: true, layout, problems: checkLayout(layout.grid) };
  });

  /**
   * Salva o desenho como traçado.
   *
   * ####  UM DESENHO COM DEFEITO É GRAVADO, E MARCADO  ####
   *
   * Recusar seria perder o trabalho de quem ia consertar a sala
   * lacrada depois — um traçado é rascunho por definição. Mas a
   * resposta traz as frases do verificador, e a lista traz o selo:
   * o que não pode acontecer é o admin não saber.
   *
   * Isso é o oposto da regra da planta de entrada (`no_hatch`), e a
   * diferença é o que cada coisa é: aquela está pronta e não
   * funciona.
   */
  app.post('/dungeon-layouts', async (request, reply) => {
    const body = dungeonLayoutInputSchema.parse(request.body);
    const existed = deps.layouts.exists(body.id);

    const layout = deps.layouts.save({
      id: body.id,
      name: body.name,
      description: body.description,
      grid: body.grid,
      origin: 'panel',
    });

    return reply
      .status(existed ? 200 : 201)
      .send({ ok: true, layout, problems: checkLayout(body.grid) });
  });

  /**
   * Apaga um traçado.
   *
   * Sem a trava de "está em uso" do acervo de plantas — e de
   * propósito: carregar um traçado COPIA o desenho para dentro da
   * masmorra. Apagar o original não muda nem quebra nenhuma
   * masmorra que partiu dele.
   */
  app.delete('/dungeon-layouts/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    if (!deps.layouts.remove(id)) throw layoutNotFound(id);

    return { ok: true };
  });
}

function notFound(id: string): ApiError {
  return new ApiError('DUNGEON_NOT_FOUND', `Não existe masmorra com o identificador "${id}".`, 404);
}

function blueprintNotFound(id: string): ApiError {
  return new ApiError('BLUEPRINT_NOT_FOUND', `Não existe planta com o identificador "${id}".`, 404);
}

function layoutNotFound(id: string): ApiError {
  return new ApiError(
    'LAYOUT_NOT_FOUND',
    `Não existe traçado com o identificador "${id}".`,
    404,
  );
}

/**
 * Apontar para uma planta que não existe.
 *
 * A masmorra nasceria sem entrada — ou, pior, com a entrada mínima
 * de código, que funciona e não é o que o admin pediu. Ele passaria
 * um wipe achando que escolheu outra coisa.
 */
function assertBlueprintExists(deps: DungeonRoutesDeps, input: DungeonInput): void {
  if (input.entranceBlueprint === null) return;

  if (deps.blueprints.summary(input.entranceBlueprint) === null) {
    throw new ApiError(
      'BLUEPRINT_MISSING',
      `A planta de entrada "${input.entranceBlueprint}" não existe no acervo.`,
      422,
    );
  }
}

/** Uma receita de fábrica, para o `duplicate` poder partir dela. */
function factoryRecipe(id: string): DungeonInput | null {
  return FACTORY_RECIPES.find((recipe) => recipe.id === id) ?? null;
}
