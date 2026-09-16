// ============================================================
//  routes/workshop.ts  -  o catálogo de skins do Steam Workshop.
//
//      GET    /workshop/skins                  a lista
//      GET    /workshop/skins/:skinId          uma
//      POST   /workshop/skins                  cria. 201
//      PUT    /workshop/skins/:skinId          edita (a skin INTEIRA)
//      DELETE /workshop/skins/:skinId          apaga
//      PUT    /workshop/skins/:skinId/servers  troca só onde ela vale
//
//      GET    /servers/:id/workshop/status     o que o plugin tem de pé
//      POST   /servers/:id/workshop/sync       manda o catálogo agora
//
//  ####  O CADASTRO RESPONDE COM OS SERVIDORES DESLIGADOS  ####
//
//  Pela mesma razão da `/custom-items`: cadastrar é trabalho de
//  madrugada, com tudo parado. As seis primeiras não falam com o
//  RCON — quem leva o catálogo ao jogo é o sync, e ele acontece
//  quando o servidor sobe. As duas últimas perguntam ao jogo, e
//  com ele fora do ar devolvem 503.
//
//  ####  O :skinId DA ROTA É O NOSSO id, E NÃO O DA OFICINA  ####
//
//  São dois números bem diferentes: o da rota é a chave da linha
//  (1, 2, 3); o do Workshop é um UInt64 de vinte dígitos que viaja
//  como TEXTO e nunca como número. Trocar um pelo outro é o tipo de
//  engano que só aparece quando o catálogo passa de dez linhas, e é
//  por isso que o parâmetro se chama `skinId` e o campo do corpo
//  também — mas o primeiro é `coerce.number()` e o segundo é string
//  com régua própria.
//
//  ####  A VALIDAÇÃO PESADA MORA AQUI  ####
//
//  O banco tem os CHECK que pegam o caminho que esquecer de validar
//  (skin ≠ '0', permissão não vazia) e os índices únicos. O resto —
//  o item base existir no catálogo do jogo, o servidor existir, a
//  marca não repetir — é zod e conferência aqui, porque a frase que
//  o admin lê precisa dizer QUAL linha já usa a marca.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ItemsRepository } from '../../db/items-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import type { WorkshopSkinsRepository } from '../../db/workshop-repository.js';
import { WorkshopCommandError, type WorkshopService } from '../../game/workshop.js';
import { workshopSkinBodySchema, type WorkshopSkin, type WorkshopSkinInput } from '../../types/workshop.js';
import { ApiError } from '../error-response.js';

export interface WorkshopRoutesDeps {
  readonly repository: WorkshopSkinsRepository;
  /** Para conferir que o item base existe nesta versão do jogo. */
  readonly items: ItemsRepository;
  /** Para conferir que os servidores escolhidos existem. */
  readonly servers: ServersRepository;
  /**
   * O canal com o jogo.
   *
   * Ausente = o agente subiu sem servidor nenhum. O cadastro
   * continua funcionando; mandar o catálogo, não — e a rota diz
   * isso em vez de fingir.
   */
  readonly workshop?: WorkshopService;
}

const skinParams = z.object({ skinId: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });
const serversBody = z.object({ servers: z.array(z.string().min(1)).max(50) });

function asApiError(cause: unknown): never {
  if (!(cause instanceof WorkshopCommandError)) throw cause;

  switch (cause.reason) {
    case 'offline':
      throw new ApiError('SERVER_OFFLINE', cause.message, 503);

    case 'no_plugin':
      throw new ApiError('WORKSHOP_PLUGIN_MISSING', cause.message, 503);

    default:
      throw new ApiError('WORKSHOP_FAILED', cause.message, 502);
  }
}

export function registerWorkshopRoutes(app: FastifyInstance, deps: WorkshopRoutesDeps): void {
  function service(): WorkshopService {
    if (deps.workshop === undefined) {
      throw new ApiError(
        'WORKSHOP_UNAVAILABLE',
        'Este agente subiu sem canal com os servidores: não há como mandar o catálogo.',
        503,
      );
    }

    return deps.workshop;
  }

  function mustGet(id: number): WorkshopSkin {
    const skin = deps.repository.get(id);

    if (skin === null) {
      throw new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(id)}.`, 404);
    }

    return skin;
  }

  function assertServer(id: string): void {
    if (deps.servers.get(id) === null) {
      throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
    }
  }

  // ==========================================================
  //  O CATÁLOGO
  // ==========================================================

  app.get('/workshop/skins', async () => {
    const skins = deps.repository.list();

    return { ok: true, count: skins.length, skins: skins.map(toBody) };
  });

  app.get('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);

    return { ok: true, skin: toBody(mustGet(skinId)) };
  });

  app.post('/workshop/skins', async (request, reply) => {
    const input = workshopSkinBodySchema.parse(request.body);

    validate(deps, input, null);

    const created = deps.repository.add(input);

    request.log.info(
      { skin: created.id, base: created.shortname, workshop: created.skinId },
      'skin do Workshop cadastrada',
    );

    // ####  SEM ISTO, A SKIN NÃO EXISTE NO JOGO  ####
    //
    // Ela fica no banco, aparece na tela, e o plugin nunca soube
    // que existe — o item continua nascendo vanilla e a permissão
    // nem chega a ser registrada no Oxide.
    //
    // Sem `await`: um servidor reiniciando não pode segurar a
    // resposta de quem acabou de salvar. O cadastro já está
    // gravado, e a reconexão o empurra de novo.
    deps.workshop?.handleCatalogChanged();

    return reply.status(201).send({ ok: true, skin: toBody(created) });
  });

  app.put('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const input = workshopSkinBodySchema.parse(request.body);

    mustGet(skinId);
    validate(deps, input, skinId);

    const saved = deps.repository.update(skinId, input);

    if (saved === null) {
      // Só chega aqui se alguém apagou a skin entre o `mustGet` e o
      // `update`. É improvável, e é exatamente por isso que merece
      // um 404 honesto em vez de um 500.
      throw new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(skinId)}.`, 404);
    }

    deps.workshop?.handleCatalogChanged();

    return { ok: true, skin: toBody(saved) };
  });

  /**
   * Troca só a lista de servidores.
   *
   * A tela de um servidor marca e desmarca skins sem ter o cadastro
   * inteiro na mão — e mandar o resto do formulário de volta só
   * para mexer numa caixa de seleção é como se perde o que outra
   * pessoa salvou no meio.
   */
  app.put('/workshop/skins/:skinId/servers', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const body = serversBody.parse(request.body);

    mustGet(skinId);
    assertKnownServers(deps, body.servers);

    const servers = deps.repository.setServers(skinId, body.servers);

    if (servers === null) {
      throw new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(skinId)}.`, 404);
    }

    deps.workshop?.handleCatalogChanged();

    return { ok: true, servers };
  });

  app.delete('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);

    mustGet(skinId);

    // ####  APAGAR É DIFERENTE DE DESLIGAR  ####
    //
    // Desligar (`enabled: false`) tira a skin do push e o item
    // volta a nascer vanilla, sem perder a marca do catálogo.
    // Apagar tira a linha — e o que já nasceu no mundo continua
    // com o número carimbado, porque quem guarda a marca é o item.
    deps.repository.remove(skinId);

    request.log.info({ skin: skinId }, 'skin do Workshop apagada');

    deps.workshop?.handleCatalogChanged();

    return { ok: true };
  });

  // ==========================================================
  //  O QUE ESTÁ NO JOGO
  // ==========================================================

  app.get('/servers/:id/workshop/status', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    try {
      return {
        ok: true,
        status: await service().status(id),
        // O que o plugin CONFIRMOU no último push, que é outra
        // pergunta: o `status` diz o que ele tem agora, e isto diz
        // o que ele disse ter recebido. Divergir entre os dois é o
        // sintoma de um `oxide.reload` que ninguém acompanhou.
        applied: service().appliedCount(id),
      };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  /**
   * Manda o catálogo agora, naquele servidor.
   *
   * O disparo manual existe para o admin que acabou de recarregar o
   * plugin à mão e não quer esperar a próxima reconexão. Ele é
   * FORÇADO: ignora o dedup, porque quem apertou o botão quer o
   * comando saindo, e não um "não mudou nada".
   */
  app.post('/servers/:id/workshop/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    const outcome = await service().sync(id, 'plugin-requested');

    if (outcome.status === 'skipped') {
      throw new ApiError(
        'SERVER_OFFLINE',
        `O RCON do servidor "${id}" está fora do ar: ${outcome.reason}. O catálogo inteiro é ` +
          'reenviado quando ele voltar.',
        503,
      );
    }

    if (outcome.status === 'pushed' && outcome.outcome.status === 'refused') {
      throw new ApiError(
        'WORKSHOP_TOO_BIG',
        `O catálogo tem ${String(outcome.outcome.bytes)} bytes e o teto do frame de console é ` +
          `${String(outcome.outcome.limitBytes)}. NADA foi enviado — meio catálogo faria o plugin ` +
          'trocar o que ele tem por uma lista incompleta. Desligue ou apague skins.',
        409,
      );
    }

    if (outcome.status === 'pushed' && outcome.outcome.status === 'failed') {
      throw new ApiError('WORKSHOP_FAILED', outcome.outcome.error.message, 502);
    }

    return { ok: true, outcome: outcome.status };
  });
}

/**
 * As conferências que o banco não faz.
 *
 * @throws ApiError com a frase pronta.
 */
function validate(
  deps: WorkshopRoutesDeps,
  input: WorkshopSkinInput,
  currentId: number | null,
): void {
  // ####  O ITEM BASE PRECISA EXISTIR NESTA VERSÃO DO JOGO  ####
  //
  // Conferir aqui é conferir no cadastro. Não conferir seria
  // descobrir dias depois, no jogo, com o item nascendo vanilla e
  // nada no log dizendo por quê — o servidor aceita QUALQUER
  // `ulong` em `item.skin` e não reclama de nada (§2.2 do
  // levantamento).
  if (deps.items.get(input.shortname) === null) {
    throw new ApiError(
      'UNKNOWN_BASE_ITEM',
      `Nenhum item do jogo com o shortname "${input.shortname}". A skin do Workshop é uma ` +
        'aparência para um item que o Rust já tem — escolha um da lista do catálogo.',
      400,
    );
  }

  const others = deps.repository.list().filter((skin) => skin.id !== currentId);

  // ####  A MARCA É ÚNICA  ####
  //
  // Duas linhas com o mesmo par (item, skin) deixariam o plugin sem
  // critério para escolher qual das duas ele está aplicando. O
  // índice único do banco também recusa; aqui a recusa vira uma
  // frase que diz QUAL skin já usa a marca.
  const clash = others.find(
    (skin) => skin.shortname === input.shortname && skin.skinId === input.skinId,
  );

  if (clash !== undefined) {
    throw new ApiError(
      'DUPLICATE_MARK',
      `A skin ${input.skinId} em "${input.shortname}" já é a marca de "${clash.label}". Duas ` +
        'linhas com a mesma marca são indistinguíveis dentro do jogo — escolha outra.',
      409,
    );
  }

  // ####  UM ITEM, UMA SKIN -- POR SERVIDOR  ####
  //
  // MEDIDO no OrigemZWorkshop.cs: o plugin indexa o catálogo POR
  // SHORTNAME e recusa a segunda linha do mesmo item com
  // `duplicate_shortname`. E é inerente ao desenho: o item nasce
  // com a skin sozinho, sem menu e sem comando, então não há
  // ninguém para escolher entre duas pedras.
  //
  // A conferência é entre as LIGADAS que dividem algum servidor:
  // trocar a arte da pedra (desliga a velha, cadastra a nova) tem
  // de continuar possível, e duas pedras em servidores diferentes
  // não se encontram. Sem isto, o cadastro é aceito aqui e
  // RECUSADO lá, com o motivo enterrado no `message` do push.
  if (input.enabled) {
    const wanted = new Set(input.servers);
    const sameItem = others.find(
      (skin) =>
        skin.enabled &&
        skin.shortname === input.shortname &&
        skin.servers.some((serverId) => wanted.has(serverId)),
    );

    if (sameItem !== undefined) {
      throw new ApiError(
        'DUPLICATE_ITEM',
        `O item "${input.shortname}" já tem a skin "${sameItem.label}" ligada nos mesmos ` +
          'servidores. O item nasce com a skin sozinho, sem menu e sem comando: com duas, ' +
          'não haveria quem escolhesse — o plugin recusaria a segunda. Desligue a outra, ou ' +
          'separe as duas por servidor.',
        409,
      );
    }
  }

  // ####  E A PERMISSÃO TAMBÉM  ####
  //
  // Duas skins com a mesma permissão fariam o admin dar uma e
  // entregar duas — e, como a permissão nasce do NOME quando o
  // painel a omite, dois nomes parecidos colidem sozinhos.
  const samePermission = others.find((skin) => skin.permission === input.permission);

  if (samePermission !== undefined) {
    throw new ApiError(
      'DUPLICATE_PERMISSION',
      `A permissão "${input.permission}" já é de "${samePermission.label}". Cada skin tem a sua: ` +
        'com a mesma, dar uma entregaria as duas.',
      409,
    );
  }

  assertKnownServers(deps, input.servers);
}

/** Servidor que não existe vira ligação órfã que o FOREIGN KEY recusa com uma frase que ninguém entende. */
function assertKnownServers(deps: WorkshopRoutesDeps, servers: readonly string[]): void {
  const known = new Set(deps.servers.list().map((server) => server.id));
  const unknown = servers.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new ApiError('UNKNOWN_SERVER', `Estes servidores não existem: ${unknown.join(', ')}.`, 400);
  }
}

/** Uma skin, na forma que a API entrega. Datas em ISO. */
function toBody(skin: WorkshopSkin) {
  return {
    id: skin.id,
    label: skin.label,
    shortname: skin.shortname,
    skinId: skin.skinId,
    permission: skin.permission,
    hideInStreamer: skin.hideInStreamer,
    enabled: skin.enabled,
    servers: skin.servers,
    createdAt: new Date(skin.createdAt).toISOString(),
    updatedAt: new Date(skin.updatedAt).toISOString(),
  };
}
