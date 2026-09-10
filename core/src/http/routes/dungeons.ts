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
import {
  spawnPointInputSchema,
  type DungeonSpawnPointsRepository,
  type SpawnPointGround,
} from '../../db/dungeon-spawn-points-repository.js';
import type { WorldEventsRepository } from '../../db/world-events-repository.js';
import type { DungeonBuildAttempt } from '../../dungeons/sync.js';
import { BLUEPRINT_PROBLEM_MESSAGE } from '../../dungeons/blueprint.js';
import type { GroundReport } from '../../game/dungeon-contract.js';
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
  /**
   * Manda o servidor erguer a masmorra.
   *
   * Ausente = o agente subiu sem canal com servidor nenhum, e a
   * rota devolve 503 em vez de fingir que mandou. A tela continua
   * inteira: desenhar masmorra com tudo parado é o caso normal.
   */
  readonly build?: (
    serverId: string,
    input: { readonly slug: string; readonly x: number; readonly z: number; readonly yaw: number },
  ) => Promise<DungeonBuildAttempt>;
  /**
   * Os lugares onde a masmorra pode nascer.
   *
   * Ausente = este agente subiu sem banco de pontos, e as rotas
   * respondem 503. Não é um estado esperado: existe para o teste
   * poder montar a rota sem a tabela.
   */
  readonly spawnPoints?: DungeonSpawnPointsRepository;
  /**
   * `"<worldSize>:<seed>"` do mundo carregado naquele servidor.
   *
   * É o que impede um ponto de mentir depois de um wipe de mapa:
   * a mesma coordenada, noutro mapa, é outro lugar. `null` = o
   * agente não sabe qual mundo está no ar.
   */
  readonly worldKeyOf?: (serverId: string) => string | null;
  /** Aquele chao serve? Ver `DungeonSync.groundAt`. */
  readonly groundAt?: (
    serverId: string,
    x: number,
    z: number,
  ) => Promise<GroundReport | null>;
}

const idParams = z.object({ id: z.string().min(1) });

const spawnPointParams = z.object({
  id: z.string().min(1),
  pointId: z.coerce.number().int().positive(),
});

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

/**
 * Onde a masmorra deve nascer.
 *
 * `yaw` é para onde ela cresce, em graus. Zero é o norte, e é o
 * padrão: dentro do jogo esse ângulo vem de para onde o admin
 * está olhando, e daqui ninguém está olhando para lugar nenhum.
 */
const buildBodySchema = z
  .object({
    serverId: z.string().min(1),
    /**
     * Um ponto do acervo. E o caminho normal do painel: o admin
     * escolheu aquele lugar uma vez, e agora só aponta para ele.
     */
    pointId: z.number().int().positive().optional(),
    x: z.number().finite().optional(),
    z: z.number().finite().optional(),
    yaw: z.number().finite().default(0),
  })
  .refine((value) => value.pointId !== undefined || (value.x !== undefined && value.z !== undefined), {
    message: 'diga onde: um ponto do acervo (pointId) ou uma coordenada (x e z)',
  });

const groundQuerySchema = z.object({
  serverId: z.string().min(1),
  x: z.coerce.number().finite(),
  z: z.coerce.number().finite(),
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
   * Ergue a masmorra, do painel.
   *
   * ####  O PASSO ⑥ DIZIA "ESTA PARTE NÃO DÁ PARA FAZER DAQUI"  ####
   *
   * E não era verdade — era só uma peça que faltava. O console do
   * jogo aceita `ozdungeon build <slug> <x> <z> [graus]` desde que a
   * frente C nasceu; o painel copiava a frase para a área de
   * transferência e ficava esperando o admin entrar no jogo e colá-la.
   *
   * ####  O QUE ESTA ROTA PROMETE, E O QUE NÃO  ####
   *
   * `sent: true` é "o comando chegou ao servidor". A construção leva
   * segundos, e quem confirma que a masmorra existe é o `built` que
   * volta pelo stream — é ele que abre a linha do histórico, com as
   * peças e a grade. O painel continua olhando o histórico, como
   * fazia quando o admin colava o comando à mão.
   *
   * Afirmar aqui que ela nasceu seria repetir o defeito que o
   * `demolish` custou a consertar: o painel dizendo ter feito o que
   * não fez.
   *
   * ####  ÁGUA É RECUSADA ANTES DE MANDAR  ####
   *
   * O painel escolhe pontos num mapa desenhado, sem ver o relevo. Em
   * 09/09/2026 uma entrada nasceu dentro de um rio e matou o dono no
   * teleporte — o `ozdungeon onde` nasceu daquele dia, e agora é
   * consultado sozinho, antes de cada construção.
   */
  app.post('/dungeons/:id/build', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = buildBodySchema.parse(request.body);

    if (!deps.dungeons.exists(id)) throw notFound(id);

    if (deps.build === undefined) {
      throw new ApiError(
        'BUILD_UNAVAILABLE',
        'Este agente subiu sem canal com os servidores: não há para quem mandar o comando.',
        503,
      );
    }

    // ####  O PONTO DO ACERVO GANHA DA COORDENADA SOLTA  ####
    //
    // Os dois caminhos existem porque o segundo é o que permite
    // erguer num lugar novo sem cadastrar nada — o mesmo motivo
    // pelo qual o plugin aceita `build <slug> <x> <z>` além do
    // "onde eu estou".
    const spot = body.pointId === undefined ? null : deps.spawnPoints?.get(body.serverId, body.pointId) ?? null;

    if (body.pointId !== undefined && spot === null) {
      throw spawnPointNotFound(body.pointId, body.serverId);
    }

    const where = spot === null
      ? { x: body.x ?? 0, z: body.z ?? 0, yaw: body.yaw }
      : { x: spot.x, z: spot.z, yaw: spot.yaw };

    const attempt = await deps.build(body.serverId, { slug: id, ...where });

    if (attempt.sent) {
      // Marcado DEPOIS de o comando sair: um ponto que não chegou a
      // ser usado não pode entrar na conta do "não repita o último".
      if (spot !== null) deps.spawnPoints?.markUsed(body.serverId, spot.id);

      return {
        ok: true,
        sent: true,
        grid: attempt.ground?.grid ?? null,
        message: `Mandei erguer${attempt.ground === null ? '' : ` em ${attempt.ground.grid}`}. A construção leva alguns segundos.`,
      };
    }

    // ####  CADA RECUSA TEM UM CÓDIGO E UMA FRASE  ####
    //
    // O código é para a tela decidir o que oferecer — parar a que
    // está de pé, escolher outro ponto — e a frase é para o admin
    // entender sem abrir o log do servidor.
    if (attempt.refused === 'occupied') {
      throw new ApiError(
        'DUNGEON_ALREADY_ACTIVE',
        attempt.reply === ''
          ? 'Já existe uma masmorra de pé nesse servidor. Derrube-a antes.'
          : attempt.reply,
        409,
      );
    }

    if (attempt.refused === 'water') {
      const depth = attempt.ground?.depth ?? 0;

      throw new ApiError(
        'BUILD_POINT_IS_WATER',
        `Aquele ponto é água: ${depth.toFixed(1)} m de profundidade em ` +
          `${attempt.ground?.grid ?? '?'}. A entrada nasceria submersa, e quem descesse ` +
          'pelo alçapão morreria na chegada.',
        422,
      );
    }

    if (attempt.refused === 'offline') {
      throw new ApiError(
        'SERVER_OFFLINE',
        'O servidor não está no fio. Uma masmorra não sobrevive a um servidor parado: ' +
          'nada dela entra no save do mundo.',
        409,
      );
    }

    throw new ApiError(
      'BUILD_FAILED',
      attempt.reply === '' ? 'O comando não chegou ao servidor.' : attempt.reply,
      502,
    );
  });

  /**
   * Aquele chão serve?
   *
   * A tela de escolher o ponto pergunta antes de o admin salvar — e
   * a resposta traz a grade, que é o que gente lê num mapa de Rust.
   */
  app.get('/dungeons/ground', async (request) => {
    const query = groundQuerySchema.parse(request.query);

    if (deps.groundAt === undefined) {
      throw new ApiError(
        'BUILD_UNAVAILABLE',
        'Este agente subiu sem canal com os servidores.',
        503,
      );
    }

    const ground = await deps.groundAt(query.serverId, query.x, query.z);

    if (ground === null) {
      throw new ApiError(
        'SERVER_OFFLINE',
        'O servidor não respondeu: só ele sabe como é o terreno ali.',
        409,
      );
    }

    return { ok: true, ground };
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
  //  OS PONTOS DE NASCIMENTO
  //
  //  ####  ELES SÃO O OPOSTO DAS event-zones  ####
  //
  //  As zonas dizem onde NADA nasce. Estes dizem onde a masmorra
  //  DEVE nascer: os lugares que o admin escolheu olhando o mapa e
  //  que ele já sabe que servem.
  //
  //  ####  A ROTA CONFERE O CHÃO NA ESCRITA  ####
  //
  //  E não recusa por causa dele. Um ponto sobre água é gravado
  //  com o aviso junto: o admin pode estar marcando uma praia que
  //  a maré do jogo cobre, ou pode ter clicado errado — quem sabe
  //  é ele. O que não pode é gravar em silêncio e o defeito
  //  aparecer quando alguém se teleportar para lá e morrer.
  //
  //  Sem servidor no fio, grava sem conferir: desenhar masmorra
  //  com tudo parado é o caso normal deste painel.
  // ==========================================================

  app.get('/servers/:id/spawn-points', async (request) => {
    const { id } = idParams.parse(request.params);

    if (deps.spawnPoints === undefined) throw spawnPointsUnavailable();

    return {
      ok: true,
      worldKey: deps.worldKeyOf?.(id) ?? null,
      points: deps.spawnPoints.list(id),
    };
  });

  app.post('/servers/:id/spawn-points', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = spawnPointInputSchema.parse(request.body);

    if (deps.spawnPoints === undefined) throw spawnPointsUnavailable();

    const checked = await checkGround(deps, id, input.x, input.z);

    const point = deps.spawnPoints.add(id, input, {
      worldKey: deps.worldKeyOf?.(id) ?? null,
      ground: checked.ground,
    });

    return reply.status(201).send({ ok: true, point, warning: checked.warning });
  });

  app.put('/servers/:id/spawn-points/:pointId', async (request) => {
    const { id, pointId } = spawnPointParams.parse(request.params);
    const input = spawnPointInputSchema.parse(request.body);

    if (deps.spawnPoints === undefined) throw spawnPointsUnavailable();

    const current = deps.spawnPoints.get(id, pointId);

    if (current === null) throw spawnPointNotFound(pointId, id);

    // Só pergunta de novo quando o ponto ANDOU: reconferir por causa
    // de um rótulo novo gastaria um comando de RCON para nada.
    const moved = current.x !== input.x || current.z !== input.z;
    const checked = moved
      ? await checkGround(deps, id, input.x, input.z)
      : { ground: undefined, warning: null };

    const point = deps.spawnPoints.update(id, pointId, input, {
      ...(moved ? { worldKey: deps.worldKeyOf?.(id) ?? null } : {}),
      ...(checked.ground === undefined ? {} : { ground: checked.ground }),
    });

    return { ok: true, point, warning: checked.warning };
  });

  app.delete('/servers/:id/spawn-points/:pointId', async (request) => {
    const { id, pointId } = spawnPointParams.parse(request.params);

    if (deps.spawnPoints === undefined) throw spawnPointsUnavailable();

    if (!deps.spawnPoints.remove(id, pointId)) throw spawnPointNotFound(pointId, id);

    return { ok: true };
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

function spawnPointsUnavailable(): ApiError {
  return new ApiError(
    'SPAWN_POINTS_UNAVAILABLE',
    'Este agente subiu sem o acervo de pontos de nascimento.',
    503,
  );
}

function spawnPointNotFound(pointId: number, serverId: string): ApiError {
  return new ApiError(
    'SPAWN_POINT_NOT_FOUND',
    `Não existe o ponto ${String(pointId)} no servidor "${serverId}".`,
    404,
  );
}

/**
 * Como e o chao ali, e o que avisar sobre ele.
 *
 * Sem servidor no fio devolve os dois vazios: gravar um ponto não
 * pode depender de o jogo estar de pé — planejar com tudo parado é
 * o caso normal deste painel.
 */
async function checkGround(
  deps: DungeonRoutesDeps,
  serverId: string,
  x: number,
  z: number,
): Promise<{
  readonly ground: SpawnPointGround | undefined;
  readonly warning: string | null;
}> {
  const report = deps.groundAt === undefined ? null : await deps.groundAt(serverId, x, z);

  if (report === null) return { ground: undefined, warning: null };

  return {
    ground: { grid: report.grid, waterDepth: report.depth, checkedAt: Date.now() },
    warning: report.serves
      ? null
      : `Atenção: aquele ponto é água (${report.depth.toFixed(1)} m em ${report.grid}). ` +
        'Uma masmorra ali nasceria com a entrada submersa.',
  };
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
