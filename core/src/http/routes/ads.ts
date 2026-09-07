// ============================================================
//  routes/ads.ts  -  O OVERLAY DE PROPAGANDAS.
//
//      GET    /api/servers/:serverId/ads                 lista + ajuste + prévia
//      POST   /api/servers/:serverId/ads                 cadastra
//      GET    /api/servers/:serverId/ads/audience        grupos e permissões do Oxide
//      PUT    /api/servers/:serverId/ads/settings        o ajuste
//      POST   /api/servers/:serverId/ads/preview         a prévia de um ajuste NÃO salvo
//      PUT    /api/servers/:serverId/ads/reorder         a ordem do rodízio
//      POST   /api/servers/:serverId/ads/refresh         rebaixa as imagens
//      POST   /api/servers/:serverId/ads/cache/clear     esquece o cache
//      POST   /api/servers/:serverId/ads/sync            empurra ao jogo agora
//      POST   /api/servers/:serverId/ads/show            força um ciclo no jogo
//      POST   /api/servers/:serverId/ads/hide            tira o overlay da tela
//      PUT    /api/servers/:serverId/ads/:id             edita (parcial)
//      DELETE /api/servers/:serverId/ads/:id
//      POST   /api/servers/:serverId/ads/:id/duplicate
//      POST   /api/servers/:serverId/ads/:id/test        mostra só esta, agora
//
//  ------------------------------------------------------------
//  ####  TUDO AQUI E POR SERVIDOR, E POR ISSO O PREFIXO  ####
//
//  O overlay do PVP anuncia o Discord do PVP. No agente antigo o
//  servidor saía de um hook de escopo (`serverOf(request)`), que
//  este agente não tem: aqui ele é um parâmetro de caminho, como
//  em `/api/servers/:id/ui`. É a mesma informação, dita no lugar
//  onde quem lê a rota a vê.
//
//  ------------------------------------------------------------
//  ####  AS ROTAS ESTATICAS VEM ANTES DAS PARAMETRICAS  ####
//
//  O Fastify resolve `/ads/settings` para a rota estática mesmo
//  com `/ads/:id` registrada, mas a ordem aqui deixa isso
//  explícito em vez de depender de um detalhe do roteador.
//
//  ------------------------------------------------------------
//  ####  SALVAR NAO ESPERA O JOGO  ####
//
//  Toda gravação avisa o sync e responde. O envio ao plugin é
//  melhor-esforço e assíncrono: um RCON fora do ar não pode
//  impedir o admin de cadastrar uma campanha — ela sai na
//  próxima volta do relógio.
//
//  A exceção são `sync`, `show`, `hide` e `test`, que SÓ existem
//  para falar com o jogo: essas respondem 503 quando não há RCON,
//  em vez de fingir que fizeram algo.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AdsRepository } from '../../db/ads-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import type { AdsSync } from '../../game/ads-sync.js';
import { buildTimeline, imageAnchors } from '../../game/ads-timeline.js';
import {
  adCreateSchema,
  adUpdateSchema,
  adsSettingsSchema,
  isPlayable,
  isWithinSchedule,
  ADS_MAX_ACTIVE,
  type Advertisement,
  type AdsSettings,
} from '../../types/ads.js';
import { ADS_PLUGIN_COMMANDS } from '../../types/ads-transport.js';
import { ApiError } from '../error-response.js';

/** O que estas rotas precisam de um RCON. E nada além disso. */
interface AdsRoutesRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

export interface AdsRoutesDeps {
  /**
   * O acervo. `ads` e `ads_settings` têm `server_id`: o overlay de
   * um mundo não é o do outro.
   */
  readonly ads: AdsRepository;

  /** Quem leva a carga ao jogo. Ver game/ads-sync.ts. */
  readonly sync: AdsSync;

  /**
   * Os servidores CADASTRADOS — o repositório, e não o supervisor.
   *
   * ####  CONFIGURAR PROPAGANDA NAO EXIGE O JOGO DE PE  ####
   *
   * O supervisor conhece os servidores MONTADOS. Usá-lo aqui faria
   * a tela responder 404 para um servidor parado, e cadastrar
   * campanha é exatamente o trabalho que se faz com tudo
   * desligado — como as regras de loot ao lado.
   *
   * Quem fala com o jogo (`show`, `hide`, `test`, `sync`) já
   * recusa sozinho, com 503 e a frase certa.
   */
  readonly servers: ServersRepository;

  /**
   * A conexão daquele servidor, quando ele está montado.
   *
   * `null` para "não montado" — e as rotas que falam com o jogo
   * tratam isso igual a "socket fora do ar", porque para quem
   * clicou o desfecho é o mesmo.
   */
  readonly supervisor: { contextOf(id: string): { readonly rcon: AdsRoutesRcon } | null };
}

/**
 * O comando que devolve grupos e permissões do Oxide.
 *
 * Mora no OrigemZUI e não no `oxide.show groups` nativo porque
 * este responde JSON: o formato do nativo é texto para uma
 * pessoa ler, e depender dele seria depender de uma formatação
 * que o Oxide pode mudar sem avisar.
 */
const AUDIENCE_COMMAND = 'origemz.ui.audience';

const serverParams = z.object({ serverId: z.string().min(1) });
const adParams = z.object({ serverId: z.string().min(1), id: z.string().min(1).max(64) });

const reorderSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).max(ADS_MAX_ACTIVE * 4) })
  .strict();

const steamIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17}$/, 'precisa ser um SteamID64 (17 dígitos)');

const targetSchema = z.object({ steamId: steamIdSchema.optional() }).strict();

export function registerAdsRoutes(app: FastifyInstance, deps: AdsRoutesDeps): void {
  // ----------------------------------------------------------
  //  GET /ads
  //
  //  Lista, ajuste e a PRÉVIA da animação numa chamada só: a tela
  //  precisa das três coisas para desenhar qualquer estado útil, e
  //  a prévia é derivada do ajuste — buscá-la à parte seria uma
  //  segunda ida à rede para um dado que acabou de sair daqui.
  // ----------------------------------------------------------
  app.get('/servers/:serverId/ads', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const settings = deps.ads.settings(serverId);
    const ads = deps.ads.list(serverId);

    return {
      ok: true,
      settings,
      ads: ads.map((ad) => toApiAd(ad, settings)),
      timeline: buildTimeline(settings),
    };
  });

  // ----------------------------------------------------------
  //  POST /ads
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const input = adCreateSchema.parse(request.body);

    // ####  O TETO E DE ATIVAS, NAO DE CADASTRADAS  ####
    //
    // Guardar cinquenta campanhas desligadas não custa nada ao
    // jogo. O que custa é a carga que desce ao plugin, e ela só
    // leva as ligadas.
    const active = deps.ads.list(serverId).filter((ad) => ad.enabled).length;

    if (input.enabled !== false && active >= ADS_MAX_ACTIVE) {
      throw new ApiError(
        'ADS_LIMIT_REACHED',
        `Já existem ${String(active)} propagandas ativas (o limite é ${String(ADS_MAX_ACTIVE)}).`,
        409,
      );
    }

    const created = deps.ads.create(serverId, input);
    deps.sync.pushSoon(serverId, 'ads-saved');

    return reply.code(201).send({ ok: true, ad: toApiAd(created, deps.ads.settings(serverId)) });
  });

  // ----------------------------------------------------------
  //  GET /ads/audience  -  os grupos e permissões do servidor.
  //
  //  ####  A LISTA PRECISA VIR DO SERVIDOR DE VERDADE  ####
  //
  //  O campo de "permissão" era texto livre, e um nome digitado
  //  errado (`vips` em vez de `vip`) não dá erro nenhum: a
  //  propaganda simplesmente não aparece para ninguém — e isso é
  //  indistinguível de "ainda não chegou a hora dela".
  //
  //  Quem conhece os nomes é o Oxide, então a lista sai dele.
  //  Sem RCON a tela cai para o campo livre, que é como ela
  //  funcionava antes: pior, mas não impede o trabalho.
  // ----------------------------------------------------------
  app.get('/servers/:serverId/ads/audience', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const rcon = connectedRconOf(deps, serverId);

    if (rcon === null) {
      return { ok: true, available: false, groups: [], permissions: [] };
    }

    try {
      const raw = await rcon.send(AUDIENCE_COMMAND);
      const parsed: unknown = JSON.parse(raw);

      const list = (value: unknown): readonly string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

      const record = parsed as { groups?: unknown; permissions?: unknown };

      return {
        ok: true,
        available: true,
        groups: list(record.groups),
        permissions: list(record.permissions),
      };
    } catch {
      // Plugin antigo (sem o comando), ou resposta que não é JSON.
      // A tela volta ao campo livre em vez de quebrar.
      return { ok: true, available: false, groups: [], permissions: [] };
    }
  });

  // ----------------------------------------------------------
  //  PUT /ads/settings
  // ----------------------------------------------------------
  app.put('/servers/:serverId/ads/settings', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const patch = adsSettingsSchema.parse(request.body);

    const before = deps.ads.settings(serverId);
    const saved = deps.ads.saveSettings(serverId, patch);

    // ####  TROCAR DE MODO INVALIDA O CACHE  ####
    //
    // O teto de tamanho depende de QUEM baixa: 420 KB quando os
    // bytes passam pelo RCON, 2 MB quando o cliente busca sozinho.
    // Sem esta limpeza, um erro gravado no modo antigo continuaria
    // na tela — "a imagem tem 953 KB e o limite é 420 KB" numa
    // configuração em que 953 KB está perfeitamente bem.
    if (saved.imageMode !== before.imageMode) {
      deps.ads.clearImageCache(serverId);
      deps.sync.clearCache(serverId);
    }

    deps.sync.pushSoon(serverId, 'settings-saved');

    request.log.info(
      { serverId, enabled: saved.enabled, imageMode: saved.imageMode },
      'ads settings saved',
    );

    return {
      ok: true,
      settings: saved,
      // A prévia volta junto porque quase tudo no ajuste muda a
      // animação — sem isto, a tela salvaria e teria de pedir a
      // prévia de novo para se redesenhar.
      timeline: buildTimeline(saved),
    };
  });

  // ----------------------------------------------------------
  //  POST /ads/preview  -  a animação de um ajuste NÃO salvo.
  //
  //  ####  SEM ELA, O PREVIEW SO MUDA DEPOIS DE SALVAR  ####
  //
  //  A tela deixa mexer em largura, margem e duração com
  //  controles deslizantes, e a prévia precisa acompanhar. A
  //  alternativa seria o navegador GERAR a animação — ou seja,
  //  uma segunda implementação do ads-timeline.ts, que divergiria
  //  no primeiro campo que uma trata e a outra não.
  //
  //  Esta rota não grava NADA: ela mescla o que veio sobre o que
  //  está salvo e devolve os quadros. É idempotente e sem efeito
  //  colateral, apesar do POST — que existe porque o ajuste
  //  inteiro não cabe numa query string.
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/preview', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const body = adsSettingsSchema.parse(request.body ?? {});

    // O `undefined` de um campo ausente precisa SUMIR antes da
    // mesclagem: com ele, `{...atual, ...body}` sobrescreveria o
    // valor salvo com `undefined` e o gerador receberia NaN.
    const patch = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    );

    const merged = { ...deps.ads.settings(serverId), ...patch } as AdsSettings;

    return { ok: true, settings: merged, timeline: buildTimeline(merged) };
  });

  // ----------------------------------------------------------
  //  PUT /ads/reorder
  // ----------------------------------------------------------
  app.put('/servers/:serverId/ads/reorder', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const { ids } = reorderSchema.parse(request.body);

    const settings = deps.ads.settings(serverId);
    const ads = deps.ads.reorder(serverId, ids);
    deps.sync.pushSoon(serverId, 'ads-saved');

    return { ok: true, ads: ads.map((ad) => toApiAd(ad, settings)) };
  });

  // ----------------------------------------------------------
  //  POST /ads/refresh
  //
  //  Rebaixa as imagens. Com `force`, refaz até as que já estavam
  //  prontas — é o que se usa quando a imagem mudou NO MESMO
  //  endereço e o cache está mostrando a antiga.
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/refresh', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const force = (request.body as { force?: unknown } | null)?.force === true;

    if (force) {
      deps.ads.clearImageCache(serverId);
      deps.sync.clearCache(serverId);
    }

    const result = await deps.sync.refreshImages(serverId, force);
    deps.sync.pushSoon(serverId, 'ads-saved');

    const settings = deps.ads.settings(serverId);

    return {
      ok: true,
      ...result,
      ads: deps.ads.list(serverId).map((ad) => toApiAd(ad, settings)),
    };
  });

  // ----------------------------------------------------------
  //  POST /ads/cache/clear
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/cache/clear', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const cleared = deps.ads.clearImageCache(serverId);
    deps.sync.clearCache(serverId);
    deps.sync.pushSoon(serverId, 'ads-saved');

    return { ok: true, cleared };
  });

  // ----------------------------------------------------------
  //  POST /ads/sync
  //
  //  Empurra AGORA e espera o desfecho — diferente do `pushSoon`
  //  das gravações. É o botão "mandar para o servidor" da tela, e
  //  ele precisa dizer se deu certo.
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/sync', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const outcome = await deps.sync.push(serverId, 'manual');

    const status = outcome.status === 'failed' || outcome.status === 'refused' ? 503 : 200;

    return reply.code(status).send({
      ok: outcome.status === 'sent',
      status: outcome.status,
      ...(outcome.status === 'sent' ? { ads: outcome.ads, bytes: outcome.bytes } : {}),
      ...(outcome.status === 'refused' || outcome.status === 'skipped'
        ? { reason: outcome.reason }
        : {}),
      ...(outcome.status === 'failed' ? { message: outcome.error.message } : {}),
    });
  });

  // ----------------------------------------------------------
  //  POST /ads/show  e  /ads/hide
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/show', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const { steamId } = targetSchema.parse(request.body ?? {});

    return runPluginCommand(
      deps,
      serverId,
      steamId === undefined ? ADS_PLUGIN_COMMANDS.show : `${ADS_PLUGIN_COMMANDS.show} ${steamId}`,
    );
  });

  app.post('/servers/:serverId/ads/hide', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    assertServer(deps, serverId);

    const { steamId } = targetSchema.parse(request.body ?? {});

    return runPluginCommand(
      deps,
      serverId,
      steamId === undefined ? ADS_PLUGIN_COMMANDS.hide : `${ADS_PLUGIN_COMMANDS.hide} ${steamId}`,
    );
  });

  // ----------------------------------------------------------
  //  PUT /ads/:id  -  parcial, como o dos avisos.
  // ----------------------------------------------------------
  app.put('/servers/:serverId/ads/:id', async (request) => {
    const { serverId, id } = adParams.parse(request.params);
    assertServer(deps, serverId);

    const patch = adUpdateSchema.parse(request.body);
    const updated = deps.ads.update(serverId, id, patch);

    if (updated === null) {
      throw notFound(id);
    }

    deps.sync.pushSoon(serverId, 'ads-saved');

    return { ok: true, ad: toApiAd(updated, deps.ads.settings(serverId)) };
  });

  // ----------------------------------------------------------
  //  DELETE /ads/:id
  // ----------------------------------------------------------
  app.delete('/servers/:serverId/ads/:id', async (request) => {
    const { serverId, id } = adParams.parse(request.params);
    assertServer(deps, serverId);

    if (!deps.ads.delete(serverId, id)) {
      throw notFound(id);
    }

    deps.sync.pushSoon(serverId, 'ads-saved');

    return { ok: true, deleted: id };
  });

  // ----------------------------------------------------------
  //  POST /ads/:id/duplicate
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/:id/duplicate', async (request, reply) => {
    const { serverId, id } = adParams.parse(request.params);
    assertServer(deps, serverId);

    const copy = deps.ads.duplicate(serverId, id);

    if (copy === null) {
      throw notFound(id);
    }

    return reply.code(201).send({ ok: true, ad: toApiAd(copy, deps.ads.settings(serverId)) });
  });

  // ----------------------------------------------------------
  //  POST /ads/:id/test
  //
  //  Mostra SÓ esta propaganda, agora, sem mexer no rodízio.
  //  Testar uma campanha não deveria adiar o próximo ciclo nem
  //  contar como exibição.
  // ----------------------------------------------------------
  app.post('/servers/:serverId/ads/:id/test', async (request) => {
    const { serverId, id } = adParams.parse(request.params);
    assertServer(deps, serverId);

    const ad = deps.ads.get(serverId, id);

    if (ad === null) {
      throw notFound(id);
    }

    const { steamId } = targetSchema.parse(request.body ?? {});
    const settings = deps.ads.settings(serverId);

    if (!isPlayable(ad, settings.imageMode)) {
      // Recusa ANTES de ir ao jogo: mandar uma propaganda sem
      // imagem desenharia um retângulo vazio, e quem clicou em
      // "testar" concluiria que a animação está quebrada.
      throw new ApiError(
        'AD_NOT_PLAYABLE',
        ad.enabled
          ? (ad.imageError ?? 'A imagem desta propaganda ainda não foi preparada.')
          : 'Esta propaganda está desativada.',
        409,
      );
    }

    const command =
      steamId === undefined
        ? `${ADS_PLUGIN_COMMANDS.test} ${ad.id}`
        : `${ADS_PLUGIN_COMMANDS.test} ${ad.id} ${steamId}`;

    return runPluginCommand(deps, serverId, command);
  });
}

// ------------------------------------------------------------

/**
 * O servidor existe?
 *
 * Sem esta conferência, um `:serverId` errado só apareceria como
 * violação de chave estrangeira na primeira gravação — erro 500
 * com o texto do SQLite, que não diz o que fazer.
 */
function assertServer(deps: AdsRoutesDeps, id: string): void {
  if (deps.servers.get(id) === null) {
    throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
  }
}

/**
 * A conexão DAQUELE servidor, quando ela está de pé.
 *
 * `null` cobre os dois casos que valem o mesmo para quem chama: o
 * servidor não está montado e o socket está fora do ar.
 */
function connectedRconOf(deps: AdsRoutesDeps, serverId: string): AdsRoutesRcon | null {
  const context = deps.supervisor.contextOf(serverId);

  return context !== null && context.rcon.isConnected ? context.rcon : null;
}

async function runPluginCommand(
  deps: AdsRoutesDeps,
  serverId: string,
  command: string,
): Promise<{ ok: true; response: string }> {
  const rcon = connectedRconOf(deps, serverId);

  if (rcon === null) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      'Sem conexão com o servidor de Rust; nada foi enviado.',
      503,
    );
  }

  try {
    const response = await rcon.send(command);
    return { ok: true, response };
  } catch (error) {
    throw new ApiError(
      'RCON_FAILED',
      error instanceof Error ? error.message : 'O comando não chegou ao servidor.',
      503,
    );
  }
}

function notFound(id: string): ApiError {
  return new ApiError('AD_NOT_FOUND', `Nenhuma propaganda com o id "${id}".`, 404);
}

/**
 * A propaganda como a tela a consome.
 *
 * Os três campos derivados existem porque a resposta é o que a
 * tela mostra, e calcular "está no ar agora?" no navegador
 * exigiria repetir lá a regra de calendário que já mora aqui —
 * duas cópias que divergem no primeiro fuso horário.
 */
function toApiAd(ad: Advertisement, settings: AdsSettings): Record<string, unknown> {
  return {
    ...ad,
    /** Passa no calendário NESTE instante? */
    inSchedule: isWithinSchedule(ad),
    /** Ligada, com imagem pronta e dentro da janela? */
    live: isPlayable(ad, settings.imageMode) && isWithinSchedule(ad),
    /** O enquadramento que o jogo vai usar — o preview usa o mesmo. */
    anchors: imageAnchors(ad.fit, settings.panelWidth, settings.panelHeight, {
      width: ad.imageWidth,
      height: ad.imageHeight,
    }),
  };
}
