// ============================================================
//  routes/kits.ts  -  a loja da rede, e a entrega dentro do jogo.
//
//      GET    /kits                      a lista da rede
//      POST   /kits                      cria
//      PUT    /kits/:id                  edita (o kit INTEIRO)
//      DELETE /kits/:id                  remove
//      GET    /kits/:id/claims           quem já pegou
//      GET    /servers/:id/kits          os kits daquele servidor
//      POST   /servers/:id/kits/:kitId/claim   entrega agora
//
//  ####  O KIT É DA REDE; A ENTREGA É DE UM SERVIDOR  ####
//
//  Por isso as duas famílias de rota. Editar um kit muda todos os
//  servidores que o oferecem; entregar acontece onde o inventário
//  existe.
//
//  ####  AQUI NÃO SE VENDE NADA  ####
//
//  O kit tinha um terceiro tipo, `compra`, com preço em centavos.
//  Ele saiu na migração 052: quem vende na rede é a LOJA, com
//  vitrine, categoria e carteira. Um `kind: "compra"` agora é
//  recusado pelo enum — inclusive o que vier do site, que precisa
//  mandar `resgate` ou `cooldown`.
//
//  ####  O PUT REESCREVE O KIT INTEIRO  ####
//
//  Não é PATCH. A tela edita o kit num formulário só e manda tudo;
//  um merge parcial abriria a pergunta "o que acontece com os itens
//  que não vieram?", e a única resposta segura para ela seria não
//  mexer — o oposto do que espera quem apagou um item na tela.
// ============================================================

import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { projectRoot } from '../../config.js';
import type { KitInput, KitsRepository } from '../../db/kits-repository.js';
import type { KitStore } from '../../kits/service.js';
import { loadoutItemsSchema } from '../../loadouts/items.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';
import { listIcons, readIcon, saveIcon, uploadedIcon } from '../icon-files.js';
import { operatorOf } from './admin.js';

export interface KitRoutesDeps {
  readonly store: KitStore;
  readonly repository: KitsRepository;
  readonly supervisor: ServerSupervisor;
}

/** Tamanho de página da lista de resgates. */
export const DEFAULT_CLAIMS_LIMIT = 50;
export const MAX_CLAIMS_LIMIT = 200;

const idParams = z.object({ id: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });
const claimParams = serverParams.extend({ kitId: z.coerce.number().int().positive() });

const claimsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CLAIMS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const offerQuery = z.object({
  /** Quando vem, a resposta diz se AQUELE jogador pode pegar. */
  steamId: z.string().min(1).optional(),
});

const claimBody = z.object({ steamId: z.string().min(1) }).strict();

/**
 * O corpo de criação e de edição.
 *
 * O `superRefine` é onde as duas formas de kit ficam honestas: um
 * kit de cooldown sem intervalo é um pedido que o banco aceitaria (a
 * coluna é anulável) e que o jogador descobriria como "clico e não
 * acontece nada".
 */
export const kitBody = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(48)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'o slug usa letras minúsculas, dígitos e hífen — por exemplo, kit-inicial',
      ),
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().max(400).nullable().default(null),
    /**
     * A arte propria do card, em `Assets\kits\`.
     *
     * ####  OMITIDO NAO E `null`  ####
     *
     * `null` e uma ESCOLHA -- "volta ao icone do primeiro item" -- e o
     * painel a manda. Omitido e "nao falei sobre isso", e e o que o
     * site manda: ele aplica os kits pelo mesmo schema e nao conhece
     * este campo. Tratá-los igual faria uma sincronizacao do site
     * apagar a arte escolhida no painel.
     */
    iconFile: z.string().trim().max(120).nullable().optional(),
    /**
     * A aba do jogo. Vazio vira `null`: um rótulo de espaços em
     * branco criaria uma aba sem nome, que ninguém consegue clicar
     * de propósito.
     */
    category: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .default(null)
      .transform((value) => (value === null || value === '' ? null : value)),
    kind: z.enum(['resgate', 'cooldown']),
    /** Em SEGUNDOS. */
    cooldownSeconds: z.number().int().min(1).max(31_536_000).nullable().default(null),
    /**
     * Quantas vezes cada jogador leva. Só em `resgate`.
     *
     * Ausente vira 1, que é o "resgate único" de sempre — e é o que
     * o site continua mandando sem saber deste campo.
     */
    useLimit: z.number().int().min(1).max(10_000).nullable().default(null),
    /** Quando a conta de usos zera. */
    useResetOn: z.enum(['never', 'wipe', 'full-wipe']).default('never'),
    /**
     * Em SEGUNDOS depois do wipe. `null` = sem bloqueio.
     *
     * Teto de 30 dias: acima disso o kit não estaria atrasado — ele
     * estaria desligado, e desligar tem campo próprio.
     */
    wipeDelaySeconds: z.number().int().min(1).max(2_592_000).nullable().default(null),
    /** `null` = qualquer um. */
    requiredTier: z.string().trim().min(1).max(32).nullable().default(null),
    /**
     * O nível exigido é EXATO?
     *
     * `false` (o padrão) = aquele nível ou um mais alto, que é como
     * o campo sempre funcionou. `true` = só aquele — e aí o Ouro
     * não pega o kit do Bronze.
     */
    requiredTierExact: z.boolean().default(false),
    items: loadoutItemsSchema,
    enabled: z.boolean().default(true),
    servers: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((kit, ctx) => {
    if (kit.requiredTierExact && kit.requiredTier === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredTierExact'],
        message:
          '"somente este nível" precisa de um nível para valer. Escolha o VIP exigido, ou ' +
          'deixe a exclusividade desligada',
      });
    }

    if (kit.kind === 'cooldown' && kit.useLimit !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['useLimit'],
        message:
          'um kit de cooldown não conta usos, e sim horas. Para dar um número fechado de vezes, ' +
          'use o tipo "resgate" com o limite que quiser',
      });
    }

    if (kit.kind === 'cooldown' && (kit.cooldownSeconds === null || kit.cooldownSeconds <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cooldownSeconds'],
        message:
          'um kit de cooldown precisa do intervalo, em segundos. Sem ele o jogador pegaria o kit ' +
          'em sequência, sem limite nenhum',
      });
    }
  });

// ============================================================
//  A ARTE PRÓPRIA DO CARD
//
//  `Assets\kits\` fica ao lado de `Assets\store\`, `Assets\items\` e
//  `Assets\ui\`, e a regra do upload é a mesma dos quatro — ver
//  http/icon-files.ts.
// ============================================================

/** Onde a arte dos kits mora, na raiz do projeto. */
export const KIT_ASSETS_DIR = join('Assets', 'kits');

/** A pasta, resolvida na hora: `projectRoot` é injetável. */
function kitIconsDir(): string {
  return join(projectRoot(), KIT_ASSETS_DIR);
}

/**
 * Os bytes da arte de um kit, ou `null`.
 *
 * É a porta da sincronização com o jogo (game/card-icons.ts). A régua
 * do nome mora no `readIcon`, e aqui ela protege o que vem do BANCO.
 */
export function readKitIcon(name: string): Buffer | null {
  return readIcon(kitIconsDir(), name);
}

/**
 * O corpo conferido, virado cadastro — resolvendo a arte.
 *
 * `iconFile` omitido conserva o que estava gravado; `null` volta ao
 * ícone do primeiro item. Ver o campo no schema.
 *
 * @param before o kit como ele está, ou `null` quando é criação.
 */
export function toKitInput(
  body: z.infer<typeof kitBody>,
  before: { readonly iconFile: string | null } | null,
): KitInput {
  return {
    ...body,
    iconFile:
      body.iconFile === undefined
        ? (before?.iconFile ?? null)
        : body.iconFile === ''
          ? null
          : body.iconFile,
  };
}

export function registerKitRoutes(app: FastifyInstance, deps: KitRoutesDeps): void {
  // ----------------------------------------------------------
  //  A arte própria — ver KIT_ASSETS_DIR
  // ----------------------------------------------------------

  app.get('/kits/icons', async () => {
    return { ok: true, icons: listIcons(kitIconsDir()) };
  });

  app.get('/kits/icons/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(request.params);
    const content = readKitIcon(name);

    if (content === null) {
      throw new ApiError('ICON_NOT_FOUND', `Nenhuma arte chamada "${name}".`, 404);
    }

    return reply.type('image/png').header('cache-control', 'private, max-age=60').send(content);
  });

  app.post('/kits/icons', async (request) => {
    const { filename, content } = await uploadedIcon(request);

    saveIcon(kitIconsDir(), filename, content);

    request.log.info(
      { icon: filename, bytes: content.length, by: operatorOf(request) },
      'arte de kit recebida',
    );

    return { ok: true, icon: { name: filename, bytes: content.length } };
  });

  // ==========================================================
  //  A loja da rede
  // ==========================================================

  app.get('/kits', async () => ({ ok: true, kits: deps.store.list() }));

  app.post('/kits', async (request, reply) => {
    const body = kitBody.parse(request.body);

    assertServers(deps, body.servers);

    if (deps.repository.getBySlug(body.slug) !== null) {
      throw new ApiError(
        'KIT_SLUG_TAKEN',
        `Já existe um kit com o slug "${body.slug}". Ele é o identificador estável do kit — o ` +
          'que o site e a interface do jogo usam para apontar para ele.',
        409,
      );
    }

    const kit = deps.repository.create(toKitInput(body, null));

    request.log.info(
      { kit: kit.slug, kind: kit.kind, servers: kit.servers, by: operatorOf(request) },
      'kit criado pelo painel',
    );

    return reply.status(201).send({
      ok: true,
      kit: deps.store.get(kit.id),
      message:
        `Kit "${kit.name}" criado.` +
        (kit.servers.length === 0
          ? ' Ele ainda NÃO é oferecido em servidor nenhum — escolha pelo menos um para ele ' +
            'aparecer na loja.'
          : ` Oferecido em ${kit.servers.join(', ')}.`),
    });
  });

  app.put('/kits/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = kitBody.parse(request.body);

    assertServers(deps, body.servers);

    const existing = deps.repository.getBySlug(body.slug);

    if (existing !== null && existing.id !== id) {
      throw new ApiError(
        'KIT_SLUG_TAKEN',
        `O slug "${body.slug}" já é do kit "${existing.name}".`,
        409,
      );
    }

    const kit = deps.repository.update(id, toKitInput(body, deps.repository.get(id)));

    if (kit === null) {
      throw new ApiError('KIT_NOT_FOUND', `Não existe kit com o id ${String(id)}.`, 404);
    }

    request.log.info({ kit: kit.slug, by: operatorOf(request) }, 'kit alterado pelo painel');

    return { ok: true, kit: deps.store.get(kit.id), message: `Kit "${kit.name}" gravado.` };
  });

  /**
   * Remove o kit.
   *
   * ####  E LEVA O HISTÓRICO DE RESGATES JUNTO  ####
   *
   * A cascata da migração 013 apaga os `kit_claims` dele — o claim
   * responde "ele já pegou ESTE kit?", e sem o kit a pergunta deixa
   * de existir. Quem quer tirar da loja sem perder o histórico
   * desliga o kit (`enabled: false`), e é isso que a mensagem diz.
   */
  app.delete('/kits/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const kit = deps.repository.get(id);

    if (kit === null || !deps.repository.remove(id)) {
      throw new ApiError('KIT_NOT_FOUND', `Não existe kit com o id ${String(id)}.`, 404);
    }

    request.log.warn(
      { kit: kit.slug, claims: kit.claimCount, by: operatorOf(request) },
      'kit removido pelo painel',
    );

    return {
      ok: true,
      message:
        `Kit "${kit.name}" removido, com ${String(kit.claimCount)} resgate(s) de histórico. ` +
        'Para tirar da loja preservando o histórico, o caminho é desligar o kit.',
    };
  });

  /** Quem já pegou este kit — inclusive as tentativas que falharam. */
  app.get('/kits/:id/claims', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit, offset } = claimsQuery.parse(request.query);

    if (deps.repository.get(id) === null) {
      throw new ApiError('KIT_NOT_FOUND', `Não existe kit com o id ${String(id)}.`, 404);
    }

    const page = deps.store.claimsOf(id, {
      limit: limit ?? DEFAULT_CLAIMS_LIMIT,
      offset: offset ?? 0,
    });

    return {
      ok: true,
      count: page.claims.length,
      ...page,
      limit: limit ?? DEFAULT_CLAIMS_LIMIT,
      offset: offset ?? 0,
    };
  });

  // ==========================================================
  //  A loja daquele servidor
  // ==========================================================

  /**
   * O que este servidor oferece.
   *
   * Com `?steamId=`, cada kit vem com `available` e o motivo da
   * recusa — é o que a interface do jogo (e a tela) usa para
   * mostrar "faltam 3 h" em vez de um botão que erra.
   */
  app.get('/servers/:id/kits', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { steamId } = offerQuery.parse(request.query);

    assertServers(deps, [id]);

    return { ok: true, kits: await deps.store.listForServer(id, steamId) };
  });

  /**
   * Entrega o kit AGORA.
   *
   * ####  EXIGE O JOGADOR DENTRO DO SERVIDOR  ####
   *
   * Item entra em inventário, e inventário só existe para quem está
   * conectado. A recusa (422 `PLAYER_OFFLINE`) diz isso com todas
   * as letras — "entre no servidor para resgatar" é acionável;
   * "falha na entrega" não.
   */
  app.post('/servers/:id/kits/:kitId/claim', async (request) => {
    const { id, kitId } = claimParams.parse(request.params);
    const { steamId } = claimBody.parse(request.body);

    assertServers(deps, [id]);

    const result = await deps.store.claim({
      kitId,
      steamId,
      serverId: id,
      actor: operatorOf(request),
    });

    return {
      ok: true,
      ...result,
      message:
        result.status === 'entregue'
          ? `Kit "${result.kit.name}" entregue a ${steamId} em ${id} ` +
            `(${String(result.delivered)} de ${String(result.total)} itens).` +
            (result.detail === null ? '' : ` ${result.detail}`)
          : `Nada foi entregue a ${steamId}. ${result.detail ?? ''}`.trim(),
    };
  });
}

/**
 * @throws {ApiError} 404 quando um dos ids não existe.
 *
 * Um kit ligado a um servidor que não existe é um kit que não
 * aparece em lugar nenhum — e a chave estrangeira recusaria isso
 * com um 500 sem explicação.
 */
function assertServers(deps: KitRoutesDeps, servers: readonly string[]): void {
  const known = new Set(deps.supervisor.ids());
  const missing = servers.filter((id) => !known.has(id));

  if (missing.length > 0) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${missing.join('", "')}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}
