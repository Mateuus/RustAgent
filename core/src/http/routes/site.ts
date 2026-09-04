// ============================================================
//  routes/site.ts  -  o pareamento com o site OrigemZ.
//
//      GET  /site/status   o pareamento visto pelo agente
//      POST /site/beacon   força uma batida agora
//
//  ####  ESTA É A PRIMEIRA TELA DE "A LOJA PAROU"  ####
//
//  "o agente está pending", "o token foi rotacionado" e "o site está
//  fora do ar" produzem o MESMO sintoma para o jogador: o botão de
//  comprar para de funcionar. Sem separar as três, cada ocorrência
//  custa uma tarde.
//
//  ####  O TOKEN NUNCA SAI DAQUI  ####
//
//  `/site/status` responde SE há token, nunca QUAL. Nada nesta rota
//  imprime segredo, nem parte dele.
//
//  ####  COM `SITE_BASE_URL` VAZIA ELAS CONTINUAM RESPONDENDO  ####
//
//  Não registrá-las faria a rota devolver 404 justamente para quem
//  está tentando descobrir por que a integração não subiu.
// ============================================================

import type { FastifyInstance } from 'fastify';

import type { StoreRepository } from '../../db/store-repository.js';
import type { SiteBeacon } from '../../site/beacon.js';
import type { SiteDomainHealth } from '../../site/domains.js';
import type { Wallet } from '../../store/wallet.js';
import { z } from 'zod';

import { normalizeSiteBaseUrl, rejectSiteBaseUrl } from '../../site/settings.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

const configBody = z.object({ baseUrl: z.string().max(300) }).strict();

/** A saúde de UM pareamento, do jeito que a tela mostra. */
export interface SitePairedServer {
  readonly beacon: SiteBeacon;
  /** O id NO SITE. Diferente do id local, e de propósito. */
  readonly siteServerId: string;
  readonly hasToken: boolean;
  /** `null` = este servidor usa a carteira LOCAL. */
  readonly walletHealth:
    | (() => { readonly lastOkAt: number | null; readonly lastError: string | null })
    | null;
}

export interface SiteRoutesDeps {
  /** Vazia = integração desligada. A rota continua respondendo. */
  readonly baseUrl: string;
  /**
   * Um por servidor pareado NO BOOT, na chave do id local.
   *
   * Só estes têm beacon, carteira e fila: eles são construídos na
   * subida, a partir do `.ini` daquele momento.
   */
  readonly servers: ReadonlyMap<string, SitePairedServer>;
  /**
   * O pareamento que está no `.ini` AGORA, por servidor.
   *
   * ####  ELE NÃO É O MESMO QUE `servers`  ####
   *
   * Quem grava o pareamento pela tela muda o `.ini` na hora, e
   * nada mais: o beacon daquele servidor só nasce no próximo
   * boot. Sem comparar os dois, a tela dizia "este servidor não
   * está pareado — sem SITE_SERVER_ID" com o `SITE_SERVER_ID`
   * gravado e visível no campo de cima. Duas afirmações opostas na
   * mesma tela, e a verdadeira era a terceira: falta reiniciar.
   */
  readonly savedPairings: () => readonly {
    readonly serverId: string;
    readonly siteServerId: string;
    readonly hasToken: boolean;
  }[];
  readonly wallet: Wallet;
  readonly purchases: StoreRepository;
  /**
   * A URL GRAVADA, lida na hora.
   *
   * ####  ELA NÃO É A MESMA QUE `baseUrl`  ####
   *
   * `baseUrl` é a que os clientes estão USANDO — ela foi lida no
   * boot e vive nos `SiteClient` já construídos. Esta é a que
   * VALE NO PRÓXIMO restart. Entre gravar e reiniciar, as duas
   * são diferentes, e a tela precisa dizer isso: sem a distinção,
   * quem grava relê o valor antigo e conclui que não gravou.
   *
   * `null` = ninguém gravou pela tela; vale o `.env`.
   */
  readonly readSavedBaseUrl: () => string | null;
  /** O padrão da instalação, para a tela poder mostrar os dois. */
  readonly envBaseUrl: string;
  /** Grava a URL nova. Vazia = desliga a integração. */
  readonly saveBaseUrl: (baseUrl: string) => void;
  /**
   * Os assuntos de REDE que o site está escrevendo.
   *
   * ####  É A PRIMEIRA TELA DE "QUEM APAGOU A LOJA?"  ####
   *
   * Enquanto um assunto aparece aqui, o snapshot do site SUBSTITUI o
   * que o painel local editar — e o sintoma de não saber disso é uma
   * oferta que volta sozinha ao que era, um minuto depois de alguém
   * salvar. Vazio = ninguém do outro lado manda em nada.
   */
  readonly domains?: () => readonly SiteDomainHealth[];
}

export function registerSiteRoutes(app: FastifyInstance, deps: SiteRoutesDeps): void {
  /**
   * A configuração do site que o painel edita.
   *
   * Hoje só a URL. O pareamento é de cada servidor e mora no `.ini`
   * dele — ver `PATCH /servers/:id`.
   */
  app.get('/site/config', () => {
    const saved = deps.readSavedBaseUrl();
    // O que a tela EDITA é o gravado; o que ela AVISA é a
    // diferença para o que está em uso.
    const baseUrl = saved ?? deps.envBaseUrl;

    return {
      ok: true,
      baseUrl,
      /** A que os clientes usam AGORA. Muda só no restart. */
      activeBaseUrl: deps.baseUrl,
      /** `true` = gravado e ainda não aplicado. */
      restartPending: baseUrl !== deps.baseUrl,
      // De onde o valor veio, para a tela poder dizer. Sem isso,
      // quem abre a tela não sabe se está vendo o padrão da
      // instalação ou algo que alguém digitou.
      source: saved === null ? ('env' as const) : ('painel' as const),
      envBaseUrl: deps.envBaseUrl === '' ? null : deps.envBaseUrl,
    };
  });

  app.put('/site/config', async (request) => {
    const body = configBody.parse(request.body);
    const problem = rejectSiteBaseUrl(body.baseUrl);

    if (problem !== null) {
      throw new ApiError('INVALID_SITE_BASE_URL', problem, 400);
    }

    const value = normalizeSiteBaseUrl(body.baseUrl);

    deps.saveBaseUrl(value);
    request.log.warn(
      { baseUrl: value === '' ? null : value, by: operatorOf(request) },
      'the site base url changed',
    );

    return {
      ok: true,
      baseUrl: value,
      // A frase que evita o "gravei e não funcionou": o cliente, o
      // beacon e a fila são montados no boot, a partir deste valor.
      message:
        value === ''
          ? 'Integração desligada. No próximo restart do agente, todas as lojas voltam para a carteira local.'
          : 'Gravado. Ele só vale a partir do próximo restart do agente.',
    };
  });

  app.get('/site/status', () => {
    const servers = [...deps.servers.entries()].map(([id, paired]) => {
      const pairing = paired.beacon.pairing;
      const health = paired.walletHealth?.() ?? null;

      return {
        serverId: id,
        siteServerId: paired.siteServerId,
        // SE há token, nunca QUAL.
        hasToken: paired.hasToken,
        status: pairing.status,
        message: pairing.message,
        lastBeaconAt: iso(pairing.lastBeaconAt),
        lastBeaconError: pairing.lastBeaconError,
        // É ele que separa BEACON_NO_CREDENTIALS de
        // AGENT_IP_NOT_ALLOWED de "o site caiu". Sete causas, sete
        // nomes: sem este campo a tela volta a ter um sintoma só.
        lastBeaconErrorCode: pairing.lastBeaconErrorCode,
        serverExists: pairing.serverExists,
        currentServerId: pairing.currentServerId,
        wallet:
          health === null
            ? { source: 'local' as const, lastOkAt: null, lastError: null }
            : { source: 'remote' as const, lastOkAt: iso(health.lastOkAt), lastError: health.lastError },
      };
    });

    // Os que a tela gravou e o boot ainda não viu. Eles NÃO têm
    // beacon nem carteira: dizer "pending" seria mentir sobre o
    // motivo, e é justamente o que a tela fazia.
    const awaiting = deps
      .savedPairings()
      .filter((saved) => saved.siteServerId !== '' && !deps.servers.has(saved.serverId))
      .map((saved) => ({
        serverId: saved.serverId,
        siteServerId: saved.siteServerId,
        hasToken: saved.hasToken,
        status: 'restart-pending' as const,
        message:
          'Gravado. O beacon, a carteira e a fila deste servidor nascem no próximo ' +
          'restart do agente.',
        lastBeaconAt: null,
        lastBeaconError: null,
        lastBeaconErrorCode: null,
        serverExists: null,
        currentServerId: null,
        wallet: { source: 'local' as const, lastOkAt: null, lastError: null },
      }));

    return {
      ok: true,
      // `paired` é o resumo que a tela lê primeiro: TODOS os
      // pareamentos ativos, e não "algum". Um que espera restart
      // não conta como pareado — ele ainda não fala com o site.
      paired:
        servers.length > 0 &&
        awaiting.length === 0 &&
        servers.every((server) => server.status === 'active'),
      baseUrl: deps.baseUrl === '' ? null : deps.baseUrl,
      servers: [...servers, ...awaiting],
      // Os assuntos em que o site MANDA. Ver o comentário em
      // `SiteRoutesDeps.domains`.
      domains: (deps.domains?.() ?? []).map((health) => ({
        domain: health.domain,
        appliedVersion: health.appliedVersion,
        lastPullAt: iso(health.lastPullAt),
        lastError: health.lastError,
        ackPending: health.ackPending,
      })),
      purchases: {
        // A compra que morreu antes do débito — e o dinheiro pode ter
        // saído. Ela não some sozinha.
        pendingOrphan: deps.purchases.countPurchasesByState('pending', Date.now() - 300_000),
        // Deve ser 0 em regime. Um número que sobe e não desce
        // significa que o settle não está resolvendo.
        chargeUnknown: deps.purchases.countPurchasesByState('charge-unknown'),
        // As que saíram do laço automático e esperam gente.
        unprovable: deps.purchases.countPurchasesByErrorPrefix('CHARGE_UNPROVABLE'),
        // O estorno que o site recusou por defeito de contrato.
        refundRejected: deps.purchases.countPurchasesByErrorPrefix('REFUND_REJECTED'),
      },
    };
  });

  /**
   * Força uma batida agora, sem esperar os 10 s.
   *
   * Existe por conveniência de operação: encurta o laço "ativei no
   * site → quando é que ele percebe?" para um clique.
   */
  app.post('/site/beacon', async (request) => {
    const { serverId } = (request.query ?? {}) as { serverId?: string };
    const targets =
      serverId === undefined
        ? [...deps.servers.entries()]
        : [...deps.servers.entries()].filter(([id]) => id === serverId);

    if (targets.length === 0) {
      // A causa mais comum é a mais confusa: o pareamento ACABOU
      // de ser gravado e o agente não reiniciou. Dizer "não
      // pareado" aqui manda a pessoa conferir um `.ini` que está
      // certo.
      const saved =
        serverId === undefined
          ? deps.savedPairings().filter((item) => item.siteServerId !== '')
          : deps.savedPairings().filter(
              (item) => item.serverId === serverId && item.siteServerId !== '',
            );

      throw new ApiError(
        'SITE_NOT_PAIRED',
        deps.baseUrl === ''
          ? 'A integração com o site está desligada: grave o endereço do site e reinicie o agente.'
          : saved.length > 0
            ? 'O pareamento está gravado, mas o agente ainda não o carregou: o beacon nasce ' +
              'no boot. Reinicie o agente e tente de novo.'
            : 'Este servidor não tem SITE_SERVER_ID no .ini. Grave o pareamento primeiro.',
        409,
      );
    }

    const beaten = await Promise.all(
      targets.map(async ([id, paired]) => {
        const pairing = await paired.beacon.beat();

        return { serverId: id, status: pairing.status, message: pairing.message };
      }),
    );

    // Falhar em beaconar NÃO é erro HTTP desta rota: quem clicou está
    // tentando descobrir o estado, e o estado é a resposta.
    return { ok: true, servers: beaten };
  });
}

/** Epoch ms vira ISO para a tela. `null` continua `null`. */
function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
