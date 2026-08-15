// ============================================================
//  service.ts  -  a compra, a única operação irreversível da loja.
//
//  ####  DUAS COISAS PRECISAM ACONTECER, EM SISTEMAS DIFERENTES  ####
//
//      carteira (o dinheiro)     ─┐
//                                 ├─ e uma delas pode falhar sozinha
//      servidor de Rust (o item) ─┘
//
//  Não existe transação entre um banco e um servidor de jogo. O que
//  existe é escolher QUAL falha é aceitável e projetar em volta
//  dela.
//
//  ####  DEBITAR ANTES DE ENTREGAR  ####
//
//    debitar -> entregar : quebrou no meio = pagou e não recebeu.
//                          É ESTORNÁVEL, e o registro diz quem.
//    entregar -> debitar : quebrou no meio = recebeu e não pagou.
//                          IRREVERSÍVEL: o item já está no mundo,
//                          pode ter sido usado, guardado ou dropado
//                          — e num servidor com wipe, tomá-lo de
//                          volta nem sempre é possível.
//
//  A primeira erra para o lado que tem conserto.
//
//  ####  E QUANDO O ESTORNO TAMBÉM FALHA  ####
//
//  Vira `failed`, que é o estado que precisa de gente. Sem ele, esse
//  caso seria uma linha de log que ninguém lê — e o jogador que
//  perdeu o saldo descobre no Discord.
//
//  ------------------------------------------------------------
//  ####  O VEÍCULO É A EXCEÇÃO, E ELA É DELIBERADA  ####
//
//  Todo o resto debita primeiro e estorna se a entrega falhar — o
//  desenho certo quando a falha é RARA. Com veículo ela não é: "não
//  tem espaço" é o caso comum de quem compra de dentro da própria
//  base. Cobrar e devolver deixa rastro no extrato e susto em quem
//  vê o saldo cair, então ele é conferido ANTES do débito.
// ============================================================

import { assertSteamId } from '../bans/service.js';
import type { PlayerEventInput } from '../db/players-repository.js';
import type {
  PurchaseState,
  StoreOffer,
  StorePurchase,
  StoreRepository,
} from '../db/store-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

import type { Wallet } from './wallet.js';

/** O comando de entrega do `OrigemZAgent`. Ver kits/service.ts. */
export const GIVE_COMMAND = 'origemz.give';

/** `origemz.vehicle.spawn <steamId> <prefab> [combustível]` */
export const VEHICLE_SPAWN_COMMAND = 'origemz.vehicle.spawn';

/** `origemz.vehicle.space <steamId>` — cabe um veículo aqui? */
export const VEHICLE_SPACE_COMMAND = 'origemz.vehicle.space';

/**
 * `auto` = tenta o inventário e joga no chão o que não couber.
 *
 * Os outros modos do plugin existem e não são usados aqui, pela
 * mesma razão dos kits: com `inventory`, quem está de mochila cheia
 * receberia INVENTORY_FULL e o item comprado sumiria.
 */
const GIVE_MODE = 'auto';

/** O que a loja precisa saber dos servidores. */
export interface StoreServers {
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

/**
 * Quem sabe conceder VIP.
 *
 * A oferta de VIP não entrega item nenhum por si — ela concede um
 * nível no sistema que JÁ existe (vip/service.ts), e daí em diante o
 * VIP vale como qualquer outro: expira, aparece no painel,
 * sincroniza com o plugin.
 *
 * Reimplementar isso aqui criaria um segundo lugar onde VIP nasce —
 * e o primeiro defeito seria um VIP comprado que nunca expira.
 */
export interface VipGranter {
  grant(input: {
    readonly steamId: string;
    readonly tier: string;
    /** Epoch ms. `null` = vitalício. */
    readonly expiresAt: number | null;
    readonly origin: 'loja';
    readonly createdBy: string | null;
  }): Promise<unknown>;
}

/** O que a loja precisa da ficha do jogador. E nada além. */
export interface StoreHistory {
  recordAction(event: PlayerEventInput): void;
}

export interface StoreServiceDeps {
  readonly repository: StoreRepository;
  readonly wallet: Wallet;
  readonly servers: StoreServers;
  /** Ausente = ofertas de VIP falham na entrega e são estornadas. */
  readonly vips?: VipGranter | undefined;
  readonly logger: Logger;
  readonly history?: StoreHistory | undefined;
  /** Injetáveis para o teste não depender do relógio nem do acaso. */
  readonly now?: () => number;
  readonly newId?: () => string;
}

export type PurchaseOutcome =
  /**
   * Não há lugar para o veículo. NADA foi cobrado.
   *
   * Desfecho normal, e não erro: o jogador está dentro da base ou
   * num penhasco. A loja diz o que fazer.
   */
  | { readonly status: 'no-space' }
  | { readonly status: 'ok'; readonly purchase: StorePurchase; readonly balance: number }
  | { readonly status: 'offer-not-found' }
  | { readonly status: 'offer-disabled' }
  | { readonly status: 'insufficient'; readonly balance: number; readonly price: number }
  | { readonly status: 'wallet-unavailable'; readonly reason: string }
  | {
      /** Debitou e não entregou. `refunded` diz se o valor voltou. */
      readonly status: 'delivery-failed';
      readonly purchase: StorePurchase;
      readonly refunded: boolean;
      readonly reason: string;
    };

export interface BuyInput {
  readonly serverId: string;
  readonly steamId: string;
  readonly offerId: string;
  readonly quantity: number;
}

/** Uma categoria com as ofertas dela. É o que a vitrine mostra. */
export interface StoreCatalogEntry {
  readonly category: { readonly id: string; readonly name: string };
  readonly offers: readonly StoreOffer[];
}

export class StoreService {
  readonly #deps: StoreServiceDeps;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(deps: StoreServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? ((): number => Date.now());
    this.#newId =
      deps.newId ??
      ((): string => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  /**
   * O catálogo que o JOGO mostra: só o que está ligado.
   *
   * Categoria desligada leva as ofertas dela junto — é o que
   * "desligar a categoria" significa para quem administra.
   */
  catalog(): readonly StoreCatalogEntry[] {
    return this.#deps.repository
      .listCategories()
      .filter((category) => category.enabled)
      .map((category) => ({
        category: { id: category.id, name: category.name },
        offers: this.#deps.repository
          .listOffersByCategory(category.id)
          .filter((offer) => offer.enabled),
      }));
  }

  /**
   * Há lugar para um veículo perto deste jogador AGORA?
   *
   * `null` = não deu para perguntar, e isso é DIFERENTE de "não
   * cabe": com `null` o modal mostra o botão assim mesmo, porque
   * recusar sem certeza seria pior — a compra confere de novo antes
   * de cobrar.
   */
  async hasVehicleSpace(serverId: string, steamId: string): Promise<boolean | null> {
    const rcon = this.#deps.servers.contextOf(serverId)?.rcon;

    if (rcon === undefined || !rcon.isConnected) {
      return null;
    }

    try {
      const response = firstJsonLine(await rcon.send(`${VEHICLE_SPACE_COMMAND} ${steamId}`));
      const space = (response as { space?: unknown } | null)?.space;

      return typeof space === 'boolean' ? space : null;
    } catch {
      return null;
    }
  }

  /**
   * Compra `quantity` vezes uma oferta.
   *
   * NUNCA lança por desfecho ruim: todos eles — inclusive os que
   * custam dinheiro — viram um `PurchaseOutcome`. Quem chama está no
   * caminho de um jogador que clicou, e uma exceção ali viraria um
   * menu travado sem explicação.
   */
  async buy(input: BuyInput): Promise<PurchaseOutcome> {
    assertSteamId(input.steamId);

    const offer = this.#deps.repository.getOffer(input.offerId);

    if (offer === null) {
      return { status: 'offer-not-found' };
    }

    if (!offer.enabled) {
      // Desligada no meio da navegação: o jogador viu a grade antes
      // de o admin apagá-la da vitrine.
      return { status: 'offer-disabled' };
    }

    // ####  O VEÍCULO É CONFERIDO ANTES DO DÉBITO  ####
    //
    // Ver o cabeçalho. Sem o RCON no ar, `hasVehicleSpace` devolve
    // `null` — e aí a compra segue: a entrega vai falhar com um
    // motivo melhor do que "não consegui perguntar", e o estorno
    // cuida.
    if (offer.kind === 'vehicle') {
      if (offer.vehicle === null) {
        // Oferta marcada como veículo e sem prefab: impossível de
        // honrar. Recusa ANTES de cobrar, como a falta de espaço.
        return { status: 'no-space' };
      }

      if ((await this.hasVehicleSpace(input.serverId, input.steamId)) === false) {
        return { status: 'no-space' };
      }
    }

    const units = Math.max(1, Math.trunc(input.quantity));
    const total = offer.price * units;
    const purchaseId = this.#newId();

    // O registro nasce ANTES de qualquer movimento. Se o processo
    // morrer no meio, fica o rastro de que alguém tentou — sem ele,
    // uma compra interrompida não deixaria vestígio nenhum.
    const purchase = this.#deps.repository.createPurchase(
      {
        id: purchaseId,
        serverId: input.serverId,
        steamId: input.steamId,
        offerId: offer.id,
        offerName: offer.name,
        // O registro guarda o ÍCONE, não "o item": um kit de dez
        // coisas não tem um shortname só. O que identifica a compra
        // é `offerName` mais o valor.
        shortname: offer.icon.shortname,
        skinId: offer.icon.skinId,
        amount: units,
        unitPrice: offer.price,
        totalPrice: total,
        state: 'pending',
        error: null,
      },
      this.#now(),
    );

    // ---- 1. o dinheiro ----
    const debit = await this.#deps.wallet.debit(
      input.steamId,
      total,
      purchaseId,
      `store:${offer.name} x${String(units)}`,
    );

    if (debit.status === 'insufficient') {
      this.#finish(input.serverId, purchaseId, 'failed', 'INSUFFICIENT_FUNDS');

      return { status: 'insufficient', balance: debit.balance, price: total };
    }

    if (debit.status === 'unavailable') {
      this.#finish(input.serverId, purchaseId, 'failed', 'WALLET_UNAVAILABLE');

      return { status: 'wallet-unavailable', reason: debit.reason };
    }

    this.#finish(input.serverId, purchaseId, 'debited');

    // ---- 2. o que foi comprado ----
    try {
      await this.#deliver(input, offer, units);
    } catch (error) {
      return await this.#refund(purchase, toError(error));
    }

    this.#finish(input.serverId, purchaseId, 'delivered');

    this.#deps.logger.info(
      {
        server: input.serverId,
        purchaseId,
        steamId: input.steamId,
        offer: offer.name,
        kind: offer.kind,
        items: offer.items.length,
        units,
        total,
      },
      'compra entregue',
    );

    this.#record(input, `comprou "${offer.name}" por ${String(total)} OZ`);

    return {
      status: 'ok',
      purchase: this.#deps.repository.getPurchase(input.serverId, purchaseId) ?? purchase,
      balance: debit.balance,
    };
  }

  /**
   * Entrega tudo o que a oferta promete. LANÇA no primeiro problema.
   *
   * ####  UM KIT SÃO VÁRIAS ENTREGAS  ####
   *
   * Elas acontecem em sequência, e uma pode falhar depois de as
   * outras terem passado. Nesse caso o estorno devolve o valor
   * INTEIRO e o jogador fica com parte dos itens — erro para o lado
   * do jogador, de propósito.
   *
   * A alternativa seria tomar de volta o que já foi entregue, e isso
   * não existe: o item pode ter sido usado, guardado ou dropado no
   * segundo seguinte.
   */
  async #deliver(input: BuyInput, offer: StoreOffer, units: number): Promise<void> {
    const rcon =
      this.#deps.servers.contextOf(input.serverId)?.rcon ?? disconnectedRcon(input.serverId);

    for (const item of offer.items) {
      const command =
        `${GIVE_COMMAND} ${input.steamId} ${item.shortname} ${String(item.amount * units)} ` +
        `${item.skinId} ${GIVE_MODE}`;

      const response = firstJsonLine(await rcon.send(command));

      if ((response as { ok?: unknown } | null)?.ok !== true) {
        const code = (response as { error?: unknown } | null)?.error;

        throw new Error(typeof code === 'string' ? code : 'GIVE_UNREADABLE');
      }
    }

    // ---- o veículo ----
    if (offer.kind === 'vehicle' && offer.vehicle !== null) {
      const response = firstJsonLine(
        await rcon.send(
          `${VEHICLE_SPAWN_COMMAND} ${input.steamId} ${offer.vehicle.prefab} ` +
            String(offer.vehicle.fuel),
        ),
      );

      if ((response as { ok?: unknown } | null)?.ok !== true) {
        // O espaço existia na conferência e sumiu no meio (outro
        // jogador construiu, um veículo parou ali). Vira falha de
        // entrega, e o estorno cuida.
        const code = (response as { error?: unknown } | null)?.error;

        throw new Error(typeof code === 'string' ? `VEHICLE_${code}` : 'VEHICLE_UNREADABLE');
      }
    }

    // ---- o VIP ----
    if (offer.vip !== null) {
      if (this.#deps.vips === undefined) {
        // Oferta de VIP num agente sem o concessor ligado. Falha
        // ANTES de dizer que deu certo — o estorno cuida do resto.
        throw new Error('VIP_GRANTER_UNAVAILABLE');
      }

      const days = offer.vip.days;

      await this.#deps.vips.grant({
        steamId: input.steamId,
        tier: offer.vip.tier,
        // Comprar duas vezes compra o DOBRO de tempo: o `grant`
        // ESTENDE o que já existe. Por isso os dias são
        // multiplicados pelas unidades.
        expiresAt: days === null ? null : this.#now() + days * units * 24 * 60 * 60 * 1000,
        origin: 'loja',
        createdBy: 'loja',
      });
    }
  }

  /**
   * A entrega falhou depois do débito. Devolve o valor.
   *
   * Se o estorno TAMBÉM falhar, o estado vira `failed` — o caso que
   * nenhum código resolve sozinho, e que a tela de compras presas
   * existe para mostrar.
   */
  async #refund(purchase: StorePurchase, cause: Error): Promise<PurchaseOutcome> {
    this.#deps.logger.warn(
      { purchaseId: purchase.id, steamId: purchase.steamId, err: cause },
      'a entrega da compra falhou; estornando',
    );

    const refund = await this.#deps.wallet.credit(
      purchase.steamId,
      purchase.totalPrice,
      purchase.id,
      `refund:${purchase.id}`,
    );

    if (refund.status === 'ok') {
      this.#finish(purchase.serverId, purchase.id, 'refunded', cause.message);

      return {
        status: 'delivery-failed',
        purchase: this.#deps.repository.getPurchase(purchase.serverId, purchase.id) ?? purchase,
        refunded: true,
        reason: cause.message,
      };
    }

    // Pagou, não recebeu, e o valor não voltou. Isto precisa de
    // gente — e é por isso que o estado existe.
    this.#finish(
      purchase.serverId,
      purchase.id,
      'failed',
      `DELIVERY_AND_REFUND_FAILED: ${cause.message}`,
    );

    this.#deps.logger.error(
      { purchaseId: purchase.id, steamId: purchase.steamId, total: purchase.totalPrice },
      'compra PRESA: debitada, não entregue e não estornada',
    );

    return {
      status: 'delivery-failed',
      purchase: this.#deps.repository.getPurchase(purchase.serverId, purchase.id) ?? purchase,
      refunded: false,
      reason: cause.message,
    };
  }

  #finish(serverId: string, id: string, state: PurchaseState, error: string | null = null): void {
    this.#deps.repository.setPurchaseState(serverId, id, state, error, this.#now());
  }

  /** A linha do tempo da ficha. Nunca derruba a compra. */
  #record(input: BuyInput, detail: string): void {
    if (this.#deps.history === undefined) {
      return;
    }

    try {
      this.#deps.history.recordAction({
        steamId: input.steamId,
        serverId: input.serverId,
        kind: 'compra',
        actor: null,
        detail,
      });
    } catch (error) {
      this.#deps.logger.debug(
        { steamId: input.steamId, err: toError(error) },
        'não consegui registrar a compra na ficha do jogador',
      );
    }
  }
}

/**
 * O desfecho vira a frase que o jogador lê.
 *
 * Ela é montada AQUI, e não no plugin: mudar o que a loja diz não
 * pode exigir recompilar o `.cs` e reiniciar o servidor.
 */
export function describePurchase(outcome: PurchaseOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return `Compra concluída: ${outcome.purchase.offerName}.`;

    case 'offer-not-found':
      return 'Este item não está mais na loja.';

    case 'offer-disabled':
      return 'Este item acabou de ser desativado.';

    case 'insufficient':
      return (
        `Saldo insuficiente: são ${outcome.price.toLocaleString('pt-BR')} OZ ` +
        `e você tem ${outcome.balance.toLocaleString('pt-BR')}.`
      );

    case 'wallet-unavailable':
      // Sem detalhe técnico: o jogador não resolve um 503, e a causa
      // já está no log com o motivo inteiro.
      return 'A carteira não respondeu. Tente de novo em instantes.';

    case 'no-space':
      // A frase diz O QUE FAZER. "Falha na entrega" deixaria o
      // jogador tentando de novo no mesmo lugar, com o mesmo
      // resultado.
      return 'Não há espaço para o veículo aqui. Vá para um lugar aberto e tente de novo.';

    case 'delivery-failed':
      return outcome.refunded
        ? 'A entrega falhou e o valor foi devolvido ao seu saldo.'
        : 'A entrega falhou e o estorno também. A equipe já foi avisada.';
  }
}
