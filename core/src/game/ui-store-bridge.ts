// ============================================================
//  ui-store-bridge.ts  -  a loja ligada ao jogo.
//
//  Três coisas moram aqui, e todas são a mesma ponte:
//
//    TELAS      quando o plugin pede a tela da loja, ela não é lida
//               do documento — é GERADA do catálogo de agora.
//
//    COMPRA     o clique em "confirmar" vira dinheiro debitado e
//               item entregue, e volta como um aviso na tela.
//
//    CABEÇALHO  o saldo e o VIP daquele jogador, trocados no lugar.
//
//  ------------------------------------------------------------
//  ####  POR QUE ISTO NÃO MORA NO ui-sync  ####
//
//  O `UiSync` é transporte: ele sabe de documentos, de RCON e do
//  teto do frame. Se ele soubesse também de preço, de carteira e de
//  estorno, a única coisa que separaria "mandar uma tela" de "cobrar
//  de alguém" seria a disciplina de quem edita o arquivo.
//
//  A fronteira são os ganchos: o `UiSync` chama, este arquivo
//  responde, e nenhum dos dois precisa do outro para ser lido.
// ============================================================

import type { Logger } from '../logger.js';
import { describePurchase, type StoreService } from '../store/service.js';
import type { Wallet } from '../store/wallet.js';
import type { UiDocument } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import { toError } from '../util.js';

import {
  BALANCE_ELEMENT_SUFFIX,
  VIP_LEFT_ELEMENT_SUFFIX,
  VIP_TIER_ELEMENT_SUFFIX,
  VIP_WORD_ELEMENT_SUFFIX,
  type HeaderValue,
} from './ui-cui.js';
import {
  buildResultScreen,
  buildStoreScreen,
  parseStoreScreenId,
  STORE_SCREEN_ID,
  type NameResolver,
} from './ui-store-screens.js';
import {
  BUNDLE_TEMPLATE_ID,
  BUY_TEMPLATE_ID,
  RESULT_TEMPLATE_ID,
  findTemplate,
} from './ui-store-template.js';
import type { UiBuyOutcome } from './ui-sync.js';

// ============================================================
//  AS TELAS
// ============================================================

export interface StoreScreenProviderOptions {
  readonly store: Pick<StoreService, 'catalog' | 'hasVehicleSpace'>;
  readonly wallet: Wallet;
  readonly logger?: Logger | undefined;
  /**
   * O nome bonito de um item do jogo.
   *
   * "rifle.ak" numa lista de kit é ilegível; quem lê quer "Assault
   * Rifle". Ausente = a lista mostra o shortname, que é feio mas
   * nunca vazio.
   */
  readonly nameOf?: NameResolver;
}

/**
 * Gera a tela quando ela é da loja; `null` para o resto.
 *
 * `null` é o que faz o `UiSync` cair no caminho normal e ler o
 * documento — este módulo não sabe nada sobre as outras telas.
 */
export function createStoreScreenProvider(
  options: StoreScreenProviderOptions,
): (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null> {
  return async (input) => {
    const target = parseStoreScreenId(input.screenId);

    if (target === null) {
      return null;
    }

    const catalog = options.store.catalog();

    // ####  O SALDO SÓ IMPORTA NO MODAL  ####
    //
    // Na grade ele não é mostrado, e consultar a carteira ali seria
    // uma ida à rede (carteira remota!) por tela, para nada. No
    // modal ele decide se o botão de comprar existe.
    let balance: number | null = null;
    let vehicleSpace: boolean | null = null;

    if (target.kind === 'item' && input.steamId !== undefined) {
      const steamId = input.steamId;

      try {
        balance = (await options.wallet.getBalance(steamId)).balance;
      } catch (error) {
        // Carteira fora do ar: o modal abre sem a linha do saldo, e
        // o botão de comprar CONTINUA lá. Escondê-lo diria "você não
        // tem dinheiro", que é diferente de "não consegui perguntar"
        // — e a compra em si já sabe recusar com o motivo certo.
        options.logger?.warn(
          { err: toError(error), steamId },
          'não consegui ler o saldo para o modal da loja',
        );
      }

      // Só para veículo, e só quando há jogador: perguntar isso ao
      // abrir o modal de uma AK seria uma ida ao plugin por nada.
      const offer = catalog
        .flatMap((entry) => entry.offers)
        .find((entry) => entry.id === target.offerId);

      if (offer?.kind === 'vehicle') {
        vehicleSpace = await options.store.hasVehicleSpace(input.serverId, steamId);
      }
    }

    const screen = buildStoreScreen({
      catalog,
      target,
      balance,
      vehicleSpace,
      // O id volta IDÊNTICO ao pedido: o plugin descarta a resposta
      // cujo id não bate com o que ele pediu.
      screenId: input.screenId,
      // Os modais desenhados no editor, se o documento os tiver.
      template: findTemplate(input.document.screens, BUY_TEMPLATE_ID),
      // Kit, VIP e veículo têm modelo PRÓPRIO: o deles hospeda uma
      // lista, e o de item não tem onde pô-la.
      bundleTemplate: findTemplate(input.document.screens, BUNDLE_TEMPLATE_ID),
      ...(options.nameOf === undefined ? {} : { nameOf: options.nameOf }),
    });

    // `STORE_SCREEN_ID` como tela ativa: o shell conhece esse
    // endereço, e é o que mantém a aba LOJA destacada mesmo dentro
    // de uma categoria ou de uma segunda página.
    return toGeneratedScreenBundle(input.document, screen, STORE_SCREEN_ID);
  };
}

// ============================================================
//  A COMPRA
// ============================================================

export interface StoreBuyHandlerOptions {
  readonly store: Pick<StoreService, 'buy'>;
  readonly wallet: Wallet;
  readonly logger?: Logger | undefined;
  /**
   * O que fazer quando o `offerId` não é uma oferta da loja.
   *
   * ####  DOIS SISTEMAS ENTRAM PELO MESMO BOTÃO  ####
   *
   * `store.buy` é a única ação de compra do modelo, e ela serve
   * tanto à loja (onde `offerId` é o id de uma oferta) quanto à
   * página de KITS (onde ele é o slug de um kit). Quem decide é a
   * EXISTÊNCIA da oferta, e não um campo a mais no clique — um campo
   * viria do cliente, e escolher o sistema pelo que o cliente manda
   * é o começo de comprar de graça.
   *
   * Ausente = o clique de um id desconhecido vira "não existe mais".
   */
  readonly fallback?: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly offerId: string;
    readonly document: UiDocument;
    readonly screenId?: string;
  }) => Promise<UiBuyOutcome>;
}

export function createStoreBuyHandler(
  options: StoreBuyHandlerOptions,
): (input: {
  readonly serverId: string;
  readonly steamId: string;
  readonly offerId: string;
  readonly quantity: number;
  readonly document: UiDocument;
  readonly screenId?: string;
}) => Promise<UiBuyOutcome> {
  return async (input) => {
    const outcome = await options.store.buy({
      serverId: input.serverId,
      steamId: input.steamId,
      offerId: input.offerId,
      quantity: input.quantity,
    });

    // Não é oferta da loja: pode ser um kit. Ver `fallback`.
    if (outcome.status === 'offer-not-found' && options.fallback !== undefined) {
      return await options.fallback({
        serverId: input.serverId,
        steamId: input.steamId,
        offerId: input.offerId,
        document: input.document,
        ...(input.screenId === undefined ? {} : { screenId: input.screenId }),
      });
    }

    const message = describePurchase(outcome);
    const ok = outcome.status === 'ok';

    // O saldo é RELIDO em vez de deduzido do desfecho: a carteira
    // pode ser a do site externo, e outra compra dele pode ter
    // acontecido no meio. Mostrar o número que o dono do saldo dá é
    // sempre melhor que mostrar a nossa conta.
    let balance: number | null = null;

    try {
      balance = (await options.wallet.getBalance(input.steamId)).balance;
    } catch (error) {
      // O saldo do aviso fica em branco. A compra já aconteceu — o
      // desfecho dela não depende desta leitura.
      options.logger?.warn(
        { err: toError(error), steamId: input.steamId },
        'não consegui ler o saldo depois da compra',
      );
    }

    return {
      ok,
      message,
      balance,
      screen: buildResult(input.document, ok, message, balance, input.screenId),
    };
  };
}

/**
 * O aviso de resultado, já convertido.
 *
 * Ele SUBSTITUI o modal da compra: desenhar um modal já destrói o
 * anterior, do lado do plugin.
 *
 * `backTo` é a página de onde o clique veio. Com ela, o OK NAVEGA de
 * volta em vez de só fechar — e é isso que faz o card do kit deixar
 * de dizer RESGATAR depois de o jogador pegá-lo. Ver
 * `buildResultScreen`.
 */
export function buildResult(
  document: UiDocument,
  ok: boolean,
  message: string,
  balance: number | null,
  backTo?: string,
): UiScreenBundle {
  return toGeneratedScreenBundle(
    document,
    buildResultScreen({
      ok,
      message,
      balance,
      template: findTemplate(document.screens, RESULT_TEMPLATE_ID),
      backTo,
    }),
    // Nenhum botão do cabeçalho aponta para o aviso, então não há
    // aba a destacar — mas passar o endereço da loja mantém LOJA
    // marcada, que é onde o jogador está.
    STORE_SCREEN_ID,
  );
}

// ============================================================
//  O CABEÇALHO
// ============================================================

/**
 * O VIP do jogador, para o cabeçalho.
 *
 * Lista vazia = não tem nenhum.
 */
export interface VipReader {
  activeOf(steamId: string): readonly { readonly tier: string; readonly expiresAt: number | null }[];
}

export interface HeaderProviderOptions {
  readonly wallet: Wallet;
  /** Ausente = o cabeçalho não mostra VIP. */
  readonly vips?: VipReader | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * O saldo e o VIP daquele jogador, prontos para o cabeçalho.
 *
 * Devolve um mapa sufixo -> valor; quem o transforma em `CuiElement`
 * é o `UiSync`, que é quem conhece os documentos.
 */
export function createHeaderProvider(
  options: HeaderProviderOptions,
): (input: {
  readonly serverId: string;
  readonly steamId: string;
}) => Promise<Readonly<Record<string, HeaderValue>>> {
  return async (input) => {
    const values: Record<string, HeaderValue> = {};

    try {
      const balance = (await options.wallet.getBalance(input.steamId)).balance;

      values[BALANCE_ELEMENT_SUFFIX] = balance.toLocaleString('pt-BR');
    } catch (error) {
      // Sem saldo, o traço continua. Melhor não dizer nada do que
      // dizer zero para quem tem dinheiro.
      options.logger?.warn(
        { err: toError(error), steamId: input.steamId },
        'não consegui ler o saldo para o cabeçalho',
      );
    }

    if (options.vips !== undefined) {
      const vip = activeVip(options.vips, input.steamId);

      // ####  SEM VIP, O CABEÇALHO NÃO DIZ NADA  ####
      //
      // "SEM VIP" ocupa o mesmo espaço e não informa: a maioria dos
      // jogadores não tem, e para eles seria um aviso permanente do
      // que lhes falta. Vazio some limpo, e a moeda fica sozinha.
      //
      // ####  A PALAVRA E O NÍVEL SÃO DOIS RÓTULOS  ####
      //
      // "VIP" fica BRANCO e o nível ganha a cor dele — bronze, prata,
      // ouro. Num rótulo só, os dois teriam a mesma cor: ou a palavra
      // vira dourada, ou o ouro vira branco.
      values[VIP_WORD_ELEMENT_SUFFIX] = vip === null ? '' : 'VIP';
      values[VIP_TIER_ELEMENT_SUFFIX] =
        vip === null ? '' : { text: vip.tier.toUpperCase(), color: tierColor(vip.tier) };
      values[VIP_LEFT_ELEMENT_SUFFIX] = describeRemaining(vip);
    }

    return values;
  };
}

/**
 * O VIP que vale para o cabeçalho.
 *
 * Com mais de um nível ativo vence o que dura MAIS — vitalício ganha
 * de todos. Mostrar o que expira amanhã seria subestimar o que a
 * pessoa comprou.
 */
function activeVip(
  vips: VipReader,
  steamId: string,
): { readonly tier: string; readonly expiresAt: number | null } | null {
  let best: { readonly tier: string; readonly expiresAt: number | null } | null = null;

  for (const vip of vips.activeOf(steamId)) {
    if (best === null || vip.expiresAt === null) {
      best = vip;
      continue;
    }

    if (best.expiresAt !== null && vip.expiresAt > best.expiresAt) {
      best = vip;
    }
  }

  return best;
}

/**
 * A cor de cada nível.
 *
 * Os metais que os nomes prometem. Nível desconhecido (renomeado
 * depois de a oferta existir) fica BRANCO: melhor sem cor do que com
 * a de outro nível.
 */
function tierColor(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'bronze':
      return '#C87F3E';
    case 'silver':
    case 'prata':
      return '#BFC5CA';
    case 'gold':
    case 'ouro':
      return '#E6B265';
    default:
      return '#E8E8E8';
  }
}

/**
 * Quanto falta do VIP, em uma linha.
 *
 * ####  DIAS, E NÃO A DATA  ####
 *
 * "vence em 12/09" obriga a pessoa a fazer a conta de cabeça olhando
 * o calendário. "faltam 23 dias" é a resposta que ela queria.
 *
 * O último dia mostra HORAS: entre "falta 1 dia" e "faltam 6 horas"
 * há uma diferença que decide se alguém renova hoje.
 */
function describeRemaining(
  vip: { readonly tier: string; readonly expiresAt: number | null } | null,
  now = Date.now(),
): string {
  if (vip === null) {
    return '';
  }

  if (vip.expiresAt === null) {
    return 'vitalício';
  }

  const ms = vip.expiresAt - now;

  if (ms <= 0) {
    // Venceu entre a leitura e agora. Dizer "faltam 0 dias" seria
    // pior que dizer que acabou.
    return 'vencido';
  }

  const hours = Math.floor(ms / (60 * 60 * 1000));

  if (hours < 24) {
    return hours <= 1 ? 'vence em menos de 1 hora' : `faltam ${String(hours)} horas`;
  }

  const days = Math.floor(hours / 24);

  return days === 1 ? 'falta 1 dia' : `faltam ${String(days)} dias`;
}
