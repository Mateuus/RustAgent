// ============================================================
//  routes/wipe-maps.ts  -  A FILA DE MAPAS de um servidor.
//
//      GET    /servers/:id/wipe/maps              a fila
//      POST   /servers/:id/wipe/maps              cola uma seed
//      POST   /servers/:id/wipe/maps/reorder      a ordem INTEIRA
//      POST   /servers/:id/wipe/maps/random       sorteia uma
//      PATCH  /servers/:id/wipe/maps/:mapId       a marca de versão
//      DELETE /servers/:id/wipe/maps/:mapId
//
//  Irmã das rotas da agenda: aquelas dizem QUANDO o servidor
//  zera, estas dizem em QUE MUNDO ele volta.
//
//  ------------------------------------------------------------
//  ####  A ORDEM DA FILA É O PRODUTO  ####
//
//  A primeira entrada pronta é o mapa do próximo wipe — é o que a
//  tela anuncia e o que o VIP enxerga antes de todo mundo. Por
//  isso `reorder` recebe a lista INTEIRA, e não um "mova para
//  cima": duas telas abertas ao mesmo tempo não podem produzir uma
//  ordem que nenhuma das duas pediu.
//
//  ------------------------------------------------------------
//  ####  MAPA CUSTOM É CONFERIDO ANTES DE ENTRAR  ####
//
//  O `HEAD` na URL acontece AQUI, na borda, antes de a linha
//  existir: responde? termina em `.map`? qual o tamanho? O passo
//  `apagar` do wipe é irreversível — descobrir que a URL não
//  responde depois dele é ficar com o mundo velho apagado e o
//  novo inexistente.
//
//  ------------------------------------------------------------
//  Nada aqui gera arquivo de mapa. Num mundo procedural não há o
//  que gerar: quem cria o terreno é o próprio Rust, no boot, a
//  partir da seed. Quem desenha a PRÉVIA é o RustMaps, e é outra
//  frente.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  isMapPoolError,
  type MapPoolRecord,
  type MapPoolRepository,
} from '../../db/map-pool-repository.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { MAP_LEVELS } from '../../types/wipe.js';
import {
  MAX_WORLD_SIZE,
  MIN_WORLD_SIZE,
  createMapUrlChecker,
  type MapUrlChecker,
} from '../../wipe/map-pool.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WipeMapsRoutesDeps {
  readonly repository: MapPoolRepository;
  readonly supervisor: ServerSupervisor;
  /**
   * Quem confere a URL do mapa custom.
   *
   * Injetável para o teste não sair na rede — e é a mesma razão
   * pela qual ele não mora no repositório: um `HEAD` no meio de
   * uma transação de SQLite é IO onde não deveria haver nenhum.
   */
  readonly checkMapUrl?: MapUrlChecker;
}

const serverParams = z.object({ id: z.string().min(1) });
const mapParams = serverParams.extend({ mapId: z.coerce.number().int().positive() });

/**
 * O corpo de "põe este mundo na fila".
 *
 * `seed` ausente ou `null` = **sorteia**. O `superRefine` é onde
 * as duas formas de entrada ficam honestas: um custom sem URL e um
 * procedural com URL são pedidos que o banco aceitaria e que
 * apareceriam como "o servidor não subiu depois do wipe".
 */
const mapBody = z
  .object({
    kind: z.enum(['procedural', 'custom']).default('procedural'),
    /** TEXTO: a seed é transportada, comparada e exibida — nunca somada. */
    seed: z.string().trim().min(1).nullable().default(null),
    worldSize: z.number().int().min(MIN_WORLD_SIZE).max(MAX_WORLD_SIZE).optional(),
    /**
     * Livre de propósito: um mapa de fora traz o nome dele. Nos
     * procedurais a rota confere contra a lista do jogo.
     */
    level: z.string().trim().min(1).max(64).optional(),
    levelUrl: z.string().trim().min(1).max(500).nullable().default(null),
    /** "Compatível com a versão nova" — só faz sentido em custom. */
    versionOk: z.boolean().default(false),
    note: z.string().trim().max(200).nullable().default(null),
  })
  .strict()
  .superRefine((map, ctx) => {
    if (map.kind === 'custom' && (map.levelUrl === null || map.levelUrl === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['levelUrl'],
        message:
          'um mapa custom precisa do link do arquivo .map — é o que vai para server.levelurl, e ' +
          'é de lá que o servidor baixa o mundo no boot',
      });
    }

    if (map.kind === 'procedural' && map.levelUrl !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['levelUrl'],
        message:
          'mundo procedural não tem link: quem gera o terreno é o próprio servidor, no boot, a ' +
          'partir da seed. Para usar um arquivo .map, marque o tipo como custom',
      });
    }

    if (
      map.kind === 'procedural' &&
      map.level !== undefined &&
      !(MAP_LEVELS as readonly string[]).includes(map.level)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['level'],
        message: `o mundo precisa ser um destes: ${MAP_LEVELS.join(', ')}`,
      });
    }
  });

/** "Sorteia uma para mim." Só o tamanho e o mundo, quando quiser dizer. */
const randomBody = z
  .object({
    worldSize: z.number().int().min(MIN_WORLD_SIZE).max(MAX_WORLD_SIZE).optional(),
    level: z.enum(MAP_LEVELS).optional(),
    note: z.string().trim().max(200).nullable().default(null),
  })
  .strict();

const reorderBody = z
  .object({
    /** A fila INTEIRA, na ordem desejada. Ver o cabeçalho. */
    ids: z.array(z.number().int().positive()).max(500),
  })
  .strict();

const patchBody = z.object({ versionOk: z.boolean() }).strict();

/** A entrada da fila como a tela a lê. */
function toResponse(entry: MapPoolRecord) {
  return {
    id: entry.id,
    serverId: entry.serverId,
    position: entry.position,
    kind: entry.kind,
    seed: entry.seed,
    worldSize: entry.worldSize,
    level: entry.level,
    levelUrl: entry.levelUrl,
    rustmapsId: entry.rustmapsId,
    staging: entry.staging,
    previewUrl: entry.previewUrl,
    thumbUrl: entry.thumbUrl,
    monuments: entry.monuments,
    status: entry.status,
    lastError: entry.lastError,
    versionOk: entry.versionOk,
    note: entry.note,
    usedAt: entry.usedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function registerWipeMapsRoutes(app: FastifyInstance, deps: WipeMapsRoutesDeps): void {
  // O checker de verdade sai na rede; o teste passa o dele.
  const checkMapUrl = deps.checkMapUrl ?? createMapUrlChecker();

  /**
   * A fila, em ordem, com as já usadas no fim.
   *
   * `next` vem separado para ninguém ter de reimplementar a regra
   * de qual entrada é a próxima — e quando ele é `null` a resposta
   * DIZ que o agente vai sortear, em vez de deixar a tela concluir
   * que o wipe está travado.
   */
  app.get('/servers/:id/wipe/maps', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const maps = deps.repository.list(id);
    const next = deps.repository.next(id);

    return {
      ok: true,
      count: maps.length,
      maps: maps.map(toResponse),
      next: next === null ? null : toResponse(next),
      /** Fila sem entrada pronta: o wipe não trava, o agente sorteia. */
      willDraw: next === null,
      message:
        next === null
          ? 'A fila não tem mapa pronto. No próximo wipe o agente sorteia uma seed, usa, e ' +
            'registra que sorteou — a fila vazia nunca segura um wipe.'
          : null,
    };
  });

  /**
   * Põe um mundo na fila.
   *
   * `warnings` sai no 201 e NÃO é erro: "esta seed já foi jogada"
   * não impede nada, mas quase sempre é engano — e um 201 mudo
   * faria o admin descobrir a repetição no dia do wipe.
   */
  app.post('/servers/:id/wipe/maps', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const body = mapBody.parse(request.body);

    assertServer(deps, id);

    let levelUrl = body.levelUrl;

    if (body.kind === 'custom' && levelUrl !== null) {
      const check = await checkMapUrl(levelUrl);

      if (!check.ok) {
        // 422, e não 400: o corpo está bem formado — o que não
        // serve é o arquivo do outro lado.
        throw new ApiError(check.code, check.message, 422);
      }

      levelUrl = check.url;
    }

    const created = mapped(() =>
      deps.repository.add(id, {
        kind: body.kind,
        seed: body.seed,
        worldSize: body.worldSize,
        level: body.level,
        levelUrl,
        versionOk: body.versionOk,
        note: body.note,
      }),
    );

    request.log.info(
      {
        server: id,
        map: created.entry.id,
        kind: created.entry.kind,
        seed: created.entry.seed,
        drawn: created.drawn,
        by: operatorOf(request),
      },
      'mapa na fila do wipe',
    );

    return reply.status(201).send({
      ok: true,
      map: toResponse(created.entry),
      warnings: created.warnings,
      drawn: created.drawn,
      message: describeCreated(created.entry, created.drawn),
    });
  });

  /**
   * Sorteia um mundo e o põe na fila.
   *
   * É o "[ sortear uma ]" da tela, e é o mesmo sorteio que a
   * execução do wipe usa quando a fila está vazia: ele evita o que
   * já está prometido na fila E o que os últimos wipes usaram.
   */
  app.post('/servers/:id/wipe/maps/random', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const body = randomBody.parse(request.body ?? {});

    assertServer(deps, id);

    const created = mapped(() =>
      deps.repository.add(id, {
        kind: 'procedural',
        seed: null,
        worldSize: body.worldSize,
        level: body.level,
        note: body.note,
      }),
    );

    request.log.info(
      { server: id, map: created.entry.id, seed: created.entry.seed, by: operatorOf(request) },
      'seed sorteada para a fila do wipe',
    );

    return reply.status(201).send({
      ok: true,
      map: toResponse(created.entry),
      warnings: created.warnings,
      drawn: true,
      message: describeCreated(created.entry, true),
    });
  });

  /**
   * Reescreve a ordem da fila.
   *
   * POST, e não PUT em `/maps`: as entradas continuam as mesmas —
   * o que muda é a ordem delas.
   */
  app.post('/servers/:id/wipe/maps/reorder', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = reorderBody.parse(request.body);

    assertServer(deps, id);

    const maps = mapped(() => deps.repository.reorder(id, body.ids));

    request.log.info(
      { server: id, ordem: body.ids, by: operatorOf(request) },
      'fila de mapas reordenada',
    );

    return {
      ok: true,
      count: maps.length,
      maps: maps.map(toResponse),
      message: 'Fila gravada na ordem da tela.',
    };
  });

  /**
   * A marca "compatível com a versão nova", do mapa custom.
   *
   * Ela é o que libera um `.map` para um wipe FORÇADO — e é
   * deliberadamente uma decisão de gente: o agente não tem como
   * saber se o arquivo carrega no binário de amanhã.
   */
  app.patch('/servers/:id/wipe/maps/:mapId', async (request) => {
    const { id, mapId } = mapParams.parse(request.params);
    const body = patchBody.parse(request.body);

    assertServer(deps, id);

    const map = mapped(() => deps.repository.markVersionOk(id, mapId, body.versionOk));

    request.log.info(
      { server: id, map: mapId, versionOk: body.versionOk, by: operatorOf(request) },
      'marca de compatibilidade do mapa custom',
    );

    return {
      ok: true,
      map: toResponse(map),
      message: body.versionOk
        ? 'Marcado como compatível: ele passa a poder entrar também num wipe forçado.'
        : 'Marca retirada: ele volta a valer só para wipe de cadência ou manual.',
    };
  });

  app.delete('/servers/:id/wipe/maps/:mapId', async (request) => {
    const { id, mapId } = mapParams.parse(request.params);

    assertServer(deps, id);

    const removed = mapped(() => deps.repository.remove(id, mapId));

    request.log.info(
      { server: id, map: mapId, seed: removed.seed, by: operatorOf(request) },
      'mapa tirado da fila do wipe',
    );

    return {
      ok: true,
      message:
        removed.kind === 'custom'
          ? 'Mapa custom tirado da fila.'
          : `Seed ${removed.seed ?? '?'} tirada da fila.`,
    };
  });
}

/**
 * A frase do 201.
 *
 * Ela diz de onde veio a seed porque a tela não pode anunciar como
 * escolha do admin um número que o agente tirou sozinho.
 */
function describeCreated(entry: MapPoolRecord, drawn: boolean): string {
  if (entry.kind === 'custom') {
    return (
      'Mapa custom na fila. Ele NÃO entra num wipe forçado enquanto ninguém marcar que é ' +
      'compatível com a versão nova do jogo.'
    );
  }

  const mundo = `seed ${entry.seed ?? '?'} em ${String(entry.worldSize ?? 0)}`;

  return drawn
    ? `Sorteei a ${mundo} — ela não está na fila nem saiu nos últimos wipes.`
    : `Na fila: ${mundo}.`;
}

/**
 * O erro de regra da fila vira o erro da API.
 *
 * As duas classes existem porque o repositório não deve conhecer
 * HTTP; a tradução é uma linha, e mora aqui.
 */
function mapped<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (isMapPoolError(error)) {
      throw new ApiError(error.code, error.message, error.status);
    }

    throw error;
  }
}

/** @throws {ApiError} 404 quando o servidor não existe neste agente. */
function assertServer(deps: WipeMapsRoutesDeps, id: string): void {
  if (deps.supervisor.ids().includes(id)) {
    return;
  }

  throw new ApiError(
    'UNKNOWN_SERVER',
    `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
      `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
    404,
  );
}
