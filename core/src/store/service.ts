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

import { z } from 'zod';

import { assertSteamId } from '../bans/service.js';
import type { PlayerEventInput } from '../db/players-repository.js';
import type {
  OfferItem,
  OfferVehicle,
  OfferVip,
  PurchaseState,
  StoreOffer,
  StorePurchase,
  StoreRepository,
} from '../db/store-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

import {
  SETTLE_CLAIM_TTL_MS,
  SETTLE_MAX_AGE_MS,
  SETTLE_MAX_ATTEMPTS,
  type SettleOutcome,
} from './settle.js';
import type { ChargeProver, Wallet } from './wallet.js';

/** O comando de entrega do `OrigemZAgent`. Ver kits/service.ts. */
export const GIVE_COMMAND = 'origemz.give';

/** `origemz.vehicle.spawn <steamId> <prefab> [combustível]` */
export const VEHICLE_SPAWN_COMMAND = 'origemz.vehicle.spawn';

/** `origemz.vehicle.space <steamId>` — cabe um veículo aqui? */
export const VEHICLE_SPACE_COMMAND = 'origemz.vehicle.space';

/**
 * Com quanto combustível nasce o veículo que veio SEM nenhum.
 *
 * ####  POR QUE ISTO MORA NA ENTREGA  ####
 *
 * Um default só de cadastro valeria para a oferta criada DEPOIS
 * dele. As que já existem gravaram `vehicle_fuel = 0` (a coluna
 * nasceu com esse default na migração 035), e a loja do site monta o
 * payload por conta própria — nenhum dos dois passa por um
 * formulário deste agente. O resultado era o mesmo dos dois lados: o
 * jogador paga por um minicopter e recebe um enfeite que não sai do
 * lugar.
 *
 * Na entrega, um ponto só cobre os dois caminhos: a compra in-game e
 * a fila do site chamam o mesmo `deliverPlan`.
 */
export const DEFAULT_VEHICLE_FUEL = 100;

/**
 * Quanto combustível o veículo leva de fato.
 *
 * ####  É DEFAULT, NÃO PISO  ####
 *
 * Só o zero vira 100. Uma oferta cadastrada com 50 entrega 50 — o
 * admin que escreveu um número pequeno quis um tanque pequeno, e o
 * problema que isto resolve é o veículo que sai SECO, não o que sai
 * com pouco.
 *
 * Veículo sem tanque (um cavalo, um barco a remo) ignora o número: o
 * plugin devolve `fuel: 0` e a entrega segue — ver `FuelVehicle` em
 * Plugins/OrigemZAgent.cs.
 */
export function vehicleFuelOf(fuel: number): number {
  return fuel > 0 ? fuel : DEFAULT_VEHICLE_FUEL;
}

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
  /**
   * A carteira DAQUELE servidor.
   *
   * ####  POR QUE UMA FUNÇÃO, E NÃO A CARTEIRA DIRETO  ####
   *
   * O site modela um `Server` por linha de `agents`, com um
   * bearer cada. Um RustAgent com três servidores de Rust tem
   * três carteiras, e a compra precisa da do servidor onde ela
   * aconteceu — senão o débito viaja com o `X-Server-Id` errado e
   * o ledger do site atribui a venda ao vizinho.
   *
   * Ausente = `wallet` para todos, que é o caso de quem não ligou
   * a integração. A interface `Wallet` não muda por causa disto:
   * quem escolhe é este arquivo, e ele já tem o `serverId` em
   * toda operação.
   */
  readonly walletFor?: ((serverId: string) => Wallet) | undefined;
  /**
   * A referência que vai ao dono do saldo.
   *
   * Ausente = o `purchaseId` cru, que é o que a carteira LOCAL
   * sempre gravou. Injetada, e não montada aqui, porque quem
   * conhece o `serverId` DO SITE é a configuração — este arquivo
   * não deve aprender que existe um site.
   */
  readonly newReference?: ((serverId: string, purchaseId: string) => string) | undefined;
  /** Teto de OZ por compra. Ausente ou 0 = sem teto. */
  readonly maxOzPerPurchase?: number | undefined;
  /**
   * Quem sabe provar uma cobrança daquele servidor.
   *
   * Ausente = sem reconciliação. O tipo vem de `./wallet.js`, e
   * não de `./site-wallet.js`: este arquivo continua sem saber
   * que existe um site.
   */
  readonly proofFor?: ((serverId: string) => ChargeProver | null) | undefined;
  /**
   * A loja daquele servidor está pronta para cobrar?
   *
   * ####  O PONTO ONDE "INDISPONÍVEL" VIRA CÓDIGO  ####
   *
   * Enquanto o pareamento não é `active`, a loja responde
   * INDISPONÍVEL — nunca "saldo 0" e nunca "saldo
   * insuficiente". Sem esta linha a lei existiria em prosa e em
   * critério de aceite, e em nenhum arquivo.
   *
   * Uma função, e não um booleano: o pareamento muda a cada 10 s,
   * e um valor lido na construção seria o de quando o agente
   * subiu.
   */
  readonly ready?: ((serverId: string) => boolean) | undefined;
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
  | {
      readonly status: 'insufficient';
      /** `null` = o dono do saldo não disse quanto era. NUNCA zero. */
      readonly balance: number | null;
      readonly price: number;
      /** A frase do DONO DO SALDO, crua. */
      readonly message: string;
    }
  | { readonly status: 'wallet-unavailable'; readonly reason: string }
  /** Passou do teto do agente. NADA foi cobrado, e nem foi tentado. */
  | { readonly status: 'over-limit'; readonly price: number; readonly limit: number }
  /** O pareamento não está `active`: a loja NÃO cobra. */
  | { readonly status: 'store-unavailable' }
  /** Já há compra aberta deste jogador. NADA foi cobrado. */
  | { readonly status: 'already-in-flight'; readonly purchase: StorePurchase }
  /**
   * O dono do saldo recusou o PEDIDO. Defeito nosso — nunca
   * repetir igual, e nunca gerar id novo.
   */
  | {
      readonly status: 'charge-rejected';
      readonly purchase: StorePurchase;
      readonly code: string;
      readonly reason: string;
      /** Preenchido = o dinheiro SAIU numa cobrança anterior. */
      readonly charged: number | null;
    }
  /**
   * PODE TER COBRADO. Não entregou, não estornou, NÃO fechou.
   *
   * O único desfecho que deixa a compra aberta: quem a resolve é
   * o relógio da reconciliação, com prova.
   */
  | {
      readonly status: 'charge-unknown';
      readonly purchase: StorePurchase;
      readonly reason: string;
    }
  | {
      /** Debitou e não entregou. `refunded` diz se o valor voltou. */
      readonly status: 'delivery-failed';
      readonly purchase: StorePurchase;
      readonly refunded: boolean;
      readonly reason: string;
    };

/**
 * O que uma compra promete entregar, congelado no momento da compra.
 *
 * ####  POR QUE ELE É GRAVADO, E NÃO RELIDO DA OFERTA  ####
 *
 * A reconciliação pode entregar minutos ou horas depois. Se ela
 * relesse `store_offers`, uma oferta editada no meio entregaria
 * OUTRA COISA, cobrada com o preço de ontem — e uma oferta apagada
 * não entregaria nada. O plano gravado é o que a compra prometeu, e
 * é ele que vale.
 *
 * A alternativa descartada foi reler a oferta e recusar se o preço
 * ou o nome divergissem: funciona, mas transforma toda edição de
 * catálogo numa compra presa a mais, e não cobre a oferta apagada.
 */
export interface DeliveryPlan {
  readonly items: readonly OfferItem[];
  readonly vehicle: OfferVehicle | null;
  readonly vip: OfferVip | null;
  /**
   * Quantas unidades. O `deliverPlan` multiplica `amount` e `days`
   * por ele.
   *
   * Nas tarefas vindas da fila do site ele é sempre 1: lá o `amount`
   * que chegou JÁ é o total.
   */
  readonly units: number;
}

/** A oferta vira plano. É o congelamento descrito acima. */
export function planOf(offer: StoreOffer, units: number): DeliveryPlan {
  return {
    items: offer.items,
    // Só a oferta marcada como veículo spawna veículo: uma oferta de
    // item com `vehicle` preenchido no banco é dado sujo, e honrá-lo
    // entregaria um carro que ninguém comprou.
    vehicle: offer.kind === 'vehicle' ? offer.vehicle : null,
    vip: offer.vip,
    units,
  };
}

/**
 * Lê o plano gravado na linha da compra.
 *
 * `null` em dois casos, e os dois são LEGÍTIMOS:
 *
 *   - compra anterior à migração 035 (a coluna nasceu NULL);
 *   - compra feita com a carteira LOCAL, antes da virada.
 *
 * Um JSON que não passa no schema também vira `null` — e `null` NÃO
 * é "entregue o que der": é "não sei o que prometi", e quem lê
 * precisa tratá-lo como conferência humana.
 */
export function planFromJson(raw: string | null): DeliveryPlan | null {
  if (raw === null) {
    return null;
  }

  try {
    const parsed = deliveryPlanSchema.parse(JSON.parse(raw));

    return {
      items: parsed.items,
      vehicle: parsed.vehicle,
      vip: parsed.vip,
      units: parsed.units,
    };
  } catch {
    return null;
  }
}

const planItemSchema = z.object({
  shortname: z.string().min(1).max(64),
  // O CUI desenha o ícone a partir dele; 0 é "não sei", e a tela
  // cai no desenho genérico em vez de não desenhar nada.
  itemId: z.number().int().min(0).default(0),
  amount: z.number().int().min(1).max(100_000),
  skinId: z.string().regex(/^\d*$/).max(20).default('0'),
});

const deliveryPlanSchema = z.object({
  items: z.array(planItemSchema).max(40).default([]),
  vehicle: z
    .object({ prefab: z.string().min(1).max(64), fuel: z.number().int().min(0).max(1000) })
    .nullable()
    .default(null),
  vip: z
    .object({ tier: z.string().min(1).max(32), days: z.number().int().min(1).max(3650).nullable() })
    .nullable()
    .default(null),
  // Congelado como 1 nas tarefas da fila: o plano JÁ está
  // multiplicado. Numa compra in-game ele é a quantidade escolhida.
  units: z.number().int().min(1).max(1000).default(1),
});


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

/**
 * Os estados que o settle sabe tratar.
 *
 * `delivered` e `refunded` já fecharam; `failed` entra porque o
 * estorno retentável mora nele, com o prefixo `REFUND_RETRYABLE`.
 */
const SETTLEABLE = new Set<PurchaseState>(['pending', 'debited', 'charge-unknown', 'failed']);

/** Quanto tempo uma compra aberta bloqueia a próxima do mesmo jogador. */
const IN_FLIGHT_WINDOW_MS = 5 * 60 * 1_000;

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

  /** A carteira DAQUELE servidor. Ver `walletFor` nas deps. */
  #wallet(serverId: string): Wallet {
    return this.#deps.walletFor?.(serverId) ?? this.#deps.wallet;
  }

  /**
   * Relê a compra depois de mexer no estado, com fallback.
   *
   * O padrão já existia inline em três lugares; os desfechos
   * novos seriam o quarto e o quinto.
   */
  #reread(serverId: string, id: string, fallback: StorePurchase): StorePurchase {
    return this.#deps.repository.getPurchase(serverId, id) ?? fallback;
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

    // ####  A LOJA SÓ COBRA QUANDO ESTÁ PRONTA  ####
    //
    // PRIMEIRA checagem do método, antes até de ler a oferta:
    // enquanto o pareamento não é `active`, todo débito tomaria
    // 401/403 e viraria `unavailable`. Dizer INDISPONÍVEL na
    // entrada é honesto; deixar passar e mostrar a frase da
    // carteira faz o jogador ler "saldo" onde o problema é
    // pareamento — e quem lê "saldo" acha que perdeu dinheiro.
    if (this.#deps.ready !== undefined && !this.#deps.ready(input.serverId)) {
      return { status: 'store-unavailable' };
    }

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

    // ####  UMA COMPRA EM VOO POR JOGADOR  ####
    //
    // A referência protege ESTA TENTATIVA de sair duas vezes; ela
    // NÃO protege o jogador de comprar duas vezes, porque cada
    // tentativa gera um `purchaseId` novo e, portanto, uma chave
    // nova. A única barreira que existia era o `PendingBuyId` do
    // plugin — e o `FailBuy` dele o zera no timeout de 8 s
    // (Plugins/OrigemZUI.cs:2075), liberando o botão com a
    // primeira compra ainda em voo.
    const open = this.#deps.repository.findOpenPurchase(
      input.serverId,
      input.steamId,
      this.#now() - IN_FLIGHT_WINDOW_MS,
    );

    if (open !== null) {
      return { status: 'already-in-flight', purchase: open };
    }

    // ####  O TETO É DO AGENTE, PORQUE O SITE NÃO TEM  ####
    //
    // Ele só recusa o que passa do saldo. Um preço editado errado,
    // ou um `quantity` que veio por rota, debita o que o jogador
    // tiver: num painel irmão essa combinação debitou 60 milhões
    // de OZ numa requisição só.
    //
    // Aqui, e não na borda HTTP nem no plugin: os dois são
    // contornáveis, e o serviço não.
    const limit = this.#deps.maxOzPerPurchase ?? 0;

    if (limit > 0 && total > limit) {
      // Nada foi criado e nada foi perguntado ao dono do saldo:
      // não há o que registrar como se tivesse acontecido. O log
      // existe para o teto apertando aparecer antes de virar
      // reclamação de jogador.
      this.#deps.logger.warn(
        { serverId: input.serverId, steamId: input.steamId, offerId: offer.id, total, limit },
        'purchase refused by the agent OZ ceiling',
      );

      return { status: 'over-limit', price: total, limit };
    }

    const purchaseId = this.#newId();
    const reference = this.#deps.newReference?.(input.serverId, purchaseId) ?? purchaseId;
    const plan = planOf(offer, units);

    // O site valida `productId` com teto de 100 chars e devolve
    // 400 `INVALID_PRODUCT_ID` acima disso — um `rejected`, que
    // FECHA a compra. O `offer.id` do agente não tem teto
    // declarado em lugar nenhum, então o limite seria descoberto
    // em produção, por um admin que só cadastrou uma oferta com
    // id comprido. Sem o campo, o site grava `product_id = NULL` e
    // a compra passa.
    const productId = offer.id.length <= 100 ? offer.id : undefined;

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
        reference,
        siteTransactionId: null,
        // O que ia ser entregue, CONGELADO. A reconciliação pode
        // entregar horas depois, e reler a oferta entregaria outra
        // coisa se alguém a editou no meio.
        delivery: JSON.stringify(plan),
        settleAttempts: 0,
        settlingAt: null,
      },
      this.#now(),
    );

    // ---- 1. o dinheiro ----
    const debit = await this.#wallet(input.serverId).debit({
      steamId: input.steamId,
      amount: total,
      reference,
      // Português, e voltado ao JOGADOR: é isto que ele lê no
      // extrato do site. `store:` era log, não texto de gente.
      reason: `Loja in-game: ${offer.name} x${String(units)}`,
      ...(productId === undefined ? {} : { productId }),
    });

    if (debit.status === 'insufficient') {
      this.#finish(input.serverId, purchaseId, 'failed', 'INSUFFICIENT_FUNDS');

      // `debit.balance` é `number | null`: `null` quando o dono do
      // saldo não disse quanto era. NUNCA zero — zero é uma
      // afirmação sobre o dinheiro de alguém.
      return {
        status: 'insufficient',
        balance: debit.balance,
        price: total,
        message: debit.message,
      };
    }

    if (debit.status === 'rejected') {
      // NUNCA gerar id novo, NUNCA repetir. `charged` preenchido
      // significa que o dinheiro saiu numa cobrança anterior com
      // esta mesma chave — isso é conferência humana, não retry.
      this.#finish(
        input.serverId,
        purchaseId,
        'failed',
        `CHARGE_REJECTED: ${debit.code}` +
          (debit.charged === null ? '' : ` charged=${String(debit.charged)}`),
      );
      this.#deps.logger.error(
        {
          purchaseId,
          reference,
          steamId: input.steamId,
          serverId: input.serverId,
          total,
          code: debit.code,
          charged: debit.charged,
        },
        'the wallet owner refused the charge',
      );

      return {
        status: 'charge-rejected',
        purchase: this.#reread(input.serverId, purchaseId, purchase),
        code: debit.code,
        reason: debit.reason,
        charged: debit.charged,
      };
    }

    if (debit.status === 'unknown') {
      // ####  O ÚNICO DESFECHO QUE NÃO FECHA A COMPRA  ####
      //
      // Nada é entregue e nada é estornado: não sabemos se cobrou.
      // Entregar seria dar item de graça se não cobrou; estornar
      // seria criar dinheiro se não cobrou. Quem decide é o
      // relógio da reconciliação, com PROVA.
      this.#finish(input.serverId, purchaseId, 'charge-unknown', 'CHARGE_UNKNOWN');
      this.#deps.logger.warn(
        {
          purchaseId,
          reference,
          steamId: input.steamId,
          serverId: input.serverId,
          total,
          reason: debit.reason,
        },
        'charge outcome is unknown; purchase left open for reconciliation',
      );

      return {
        status: 'charge-unknown',
        purchase: this.#reread(input.serverId, purchaseId, purchase),
        reason: debit.reason,
      };
    }

    if (debit.status === 'unavailable') {
      this.#finish(input.serverId, purchaseId, 'failed', 'WALLET_UNAVAILABLE');

      return { status: 'wallet-unavailable', reason: debit.reason };
    }

    // O id do ledger do site entra AQUI, na única transição que o
    // conhece. O `COALESCE` do repositório impede que a transição
    // seguinte (`delivered`, sem id) apague a prova.
    this.#finish(input.serverId, purchaseId, 'debited', null, debit.transactionId);

    // ---- 2. o que foi comprado ----
    try {
      // O MESMO plano que foi gravado na linha: entregar a partir
      // dele, e não da oferta, é o que faz a compra e a
      // reconciliação entregarem a mesma coisa.
      await this.deliverPlan(input.serverId, input.steamId, plan);
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
  /**
   * Entrega um plano. É o MESMO caminho da compra in-game.
   *
   * ####  UM LUGAR SÓ MANDA `origemz.give`  ####
   *
   * A fila de entregas do site e a compra precisam do mesmo
   * comando, do mesmo `auto`, do mesmo tratamento de veículo e do
   * mesmo `vips.grant`. Dois caminhos divergiriam no primeiro
   * ajuste — e o ajuste que só um dos dois recebesse apareceria
   * como "às vezes o item vem sem skin".
   *
   * LANÇA com o código CRU do plugin (ou o `ApiError` do RCON):
   * quem chama traduz. Ela não devolve desfecho porque a compra e
   * a fila fecham de jeitos diferentes.
   */
  async deliverPlan(serverId: string, steamId: string, plan: DeliveryPlan): Promise<void> {
    const rcon = this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);
    const units = plan.units;

    for (const item of plan.items) {
      const command =
        `${GIVE_COMMAND} ${steamId} ${item.shortname} ${String(item.amount * units)} ` +
        `${item.skinId} ${GIVE_MODE}`;

      const response = firstJsonLine(await rcon.send(command));

      if ((response as { ok?: unknown } | null)?.ok !== true) {
        const code = (response as { error?: unknown } | null)?.error;

        throw new Error(typeof code === 'string' ? code : 'GIVE_UNREADABLE');
      }
    }

    // ---- o veículo ----
    if (plan.vehicle !== null) {
      const response = firstJsonLine(
        await rcon.send(
          `${VEHICLE_SPAWN_COMMAND} ${steamId} ${plan.vehicle.prefab} ` +
            String(vehicleFuelOf(plan.vehicle.fuel)),
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
    if (plan.vip !== null) {
      if (this.#deps.vips === undefined) {
        // Oferta de VIP num agente sem o concessor ligado. Falha
        // ANTES de dizer que deu certo — o estorno cuida do resto.
        throw new Error('VIP_GRANTER_UNAVAILABLE');
      }

      const days = plan.vip.days;

      await this.#deps.vips.grant({
        steamId,
        tier: plan.vip.tier,
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

    const refund = await this.#wallet(purchase.serverId).credit({
      steamId: purchase.steamId,
      amount: purchase.totalPrice,
      // A referência da COMPRA. O sufixo `:refund` é derivado
      // DENTRO da carteira: com a mesma chave do débito, o site
      // trataria o crédito como replay, responderia `idempotent`
      // e NÃO creditaria — o jogador ficaria sem o item e sem o
      // dinheiro, com sucesso em todo lugar que alguém olhasse.
      reference: purchase.reference ?? purchase.id,
      reason: `Estorno: entrega falhou (${cause.message})`,
    });

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

  #finish(
    serverId: string,
    id: string,
    state: PurchaseState,
    error: string | null = null,
    /** Só na transição para `debited`: é a prova da cobrança. */
    siteTransactionId: string | null = null,
  ): void {
    this.#deps.repository.setPurchaseState(
      serverId,
      id,
      state,
      error,
      this.#now(),
      siteTransactionId,
    );
  }


  /**
   * Fecha uma compra presa, com prova.
   *
   * É a MESMA função que o relógio e o botão chamam. Dois códigos
   * que decidem isto discordariam no primeiro ajuste, e o dia em que
   * discordassem seria o dia em que alguém foi cobrado duas vezes.
   *
   * `null` = NENHUM desfecho: o dono do saldo não respondeu, é cedo
   * demais, ou outro já pegou esta linha. Não é erro — é a
   * invariante "na dúvida, preserva".
   */
  async settle(input: {
    readonly serverId: string;
    readonly purchaseId: string;
  }): Promise<SettleOutcome> {
    const before = this.#deps.repository.getPurchase(input.serverId, input.purchaseId);

    if (before === null || !SETTLEABLE.has(before.state)) {
      return null;
    }

    // Sem carteira do site não há como provar nada. Acontece depois
    // de um rollback (`SITE_BASE_URL` vazia) e num servidor que
    // nunca foi pareado.
    if ((this.#deps.proofFor?.(input.serverId) ?? null) === null) {
      return null;
    }

    const now = this.#now();

    // ####  A LINHA É RECLAMADA ANTES DE QUALQUER AÇÃO  ####
    //
    // O `#running` do relógio protege contra duas rodadas dele, não
    // contra o relógio e um humano clicando no botão ao mesmo tempo.
    // Duas execuções concorrentes sobre a mesma compra produziriam
    // duas provas 200, duas gravações de `debited` e DUAS ENTREGAS —
    // item duplicado, uma cobrança.
    if (
      !this.#deps.repository.claimForSettle(
        input.serverId,
        input.purchaseId,
        before.state,
        now,
        now - SETTLE_CLAIM_TTL_MS,
      )
    ) {
      return null;
    }

    try {
      // Relida DEPOIS da reivindicação: é ela que incrementa o
      // contador de tentativas, e o teto se conta sobre o valor novo.
      const claimed = this.#reread(input.serverId, input.purchaseId, before);

      return await this.#settleClaimed(claimed, now);
    } finally {
      this.#deps.repository.releaseSettleClaim(input.serverId, input.purchaseId, this.#now());
    }
  }

  async #settleClaimed(purchase: StorePurchase, now: number): Promise<SettleOutcome> {
    // ####  OS DOIS TETOS, E ELES SÃO POR COMPRA  ####
    //
    // Um relógio que tenta para sempre é um gerador de carga. Ao
    // estourar, a compra sai do laço automático e espera gente — o
    // botão continua funcionando para quem consertou a causa.
    if (
      purchase.settleAttempts > SETTLE_MAX_ATTEMPTS ||
      now - purchase.createdAt > SETTLE_MAX_AGE_MS
    ) {
      return this.#giveUp(purchase, `after ${String(purchase.settleAttempts)} attempts`);
    }

    // ####  `debited` PARADO NÃO É REENTREGUE ÀS CEGAS  ####
    //
    // O dinheiro saiu e a entrega não fechou. Repetir o
    // `origemz.give` entregaria duas vezes se o primeiro tiver saído
    // — e não há como saber daqui.
    if (purchase.state === 'debited') {
      this.#deps.logger.error(
        this.#logFields(purchase),
        'purchase debited and not delivered; needs a human',
      );

      return 'review';
    }

    // ####  ESTORNO RETENTÁVEL: A MESMA CHAVE, DE NOVO  ####
    //
    // Repetir um crédito com `:refund` é SEGURO — o site devolve
    // `idempotent: true` e não credita duas vezes. É o oposto do
    // débito, e é o que permite insistir.
    if (purchase.state === 'failed') {
      return await this.#retryRefund(purchase);
    }

    if (purchase.reference === null) {
      // Sem referência não há o que perguntar. Acontece com a compra
      // que morreu entre a criação da linha e a gravação, e com as
      // anteriores à migração 035 — e deixá-la muda é o mesmo que não
      // ter estado.
      this.#finish(purchase.serverId, purchase.id, 'failed', 'CHARGE_UNKNOWN_NO_REFERENCE');
      this.#deps.logger.error(
        this.#logFields(purchase),
        'stuck purchase has no reference; nothing can be proven',
      );

      return 'review';
    }

    const prover = this.#deps.proofFor?.(purchase.serverId) ?? null;

    if (prover === null) {
      return null;
    }

    const result = await prover.proveCharge({
      reference: purchase.reference,
      steamId: purchase.steamId,
    });

    if (result.status === 'unknown') {
      // NÃO decide nada. O minuto seguinte tenta de novo, até o teto.
      return null;
    }

    if (result.status === 'unprovable') {
      return this.#giveUp(purchase, result.reason);
    }

    if (result.status === 'not-charged') {
      // Prova de que nada saiu: o jogador não perdeu nada, e NENHUMA
      // cobrança é feita agora.
      this.#finish(purchase.serverId, purchase.id, 'failed', 'CHARGE_NEVER_HAPPENED');
      this.#deps.logger.info(
        this.#logFields(purchase),
        'stuck purchase was never charged; closed without charging anyone',
      );

      return 'cancelled';
    }

    // A cobrança EXISTE. A compra volta ao fluxo normal — e o plano
    // congelado é o que ela prometeu, não o que a oferta diz hoje.
    const plan = planFromJson(purchase.delivery);

    this.#finish(purchase.serverId, purchase.id, 'debited', null, result.transactionId);

    if (plan === null) {
      // O dinheiro saiu e não sabemos o que prometemos. Entregar "o
      // que der" seria inventar a compra de alguém.
      this.#finish(purchase.serverId, purchase.id, 'debited', 'PLAN_MISSING');
      this.#deps.logger.error(
        this.#logFields(purchase),
        'charge proven but the delivery plan is missing; needs a human',
      );

      return 'review';
    }

    try {
      await this.deliverPlan(purchase.serverId, purchase.steamId, plan);
    } catch (error) {
      const outcome = await this.#refund(
        this.#reread(purchase.serverId, purchase.id, purchase),
        toError(error),
      );

      return outcome.status === 'delivery-failed' && outcome.refunded ? 'refunded' : 'review';
    }

    this.#finish(purchase.serverId, purchase.id, 'delivered');
    this.#deps.logger.info(this.#logFields(purchase), 'stuck purchase settled and delivered');

    return 'delivered';
  }

  /** Repete um estorno que falhou por timeout ou por indisponibilidade. */
  async #retryRefund(purchase: StorePurchase): Promise<SettleOutcome> {
    const refund = await this.#wallet(purchase.serverId).credit({
      steamId: purchase.steamId,
      amount: purchase.totalPrice,
      reference: purchase.reference ?? purchase.id,
      reason: `Estorno: entrega falhou (${purchase.error ?? 'sem motivo'})`,
    });

    if (refund.status === 'ok') {
      this.#finish(purchase.serverId, purchase.id, 'refunded', purchase.error);

      return 'refunded';
    }

    if (refund.status === 'rejected' || refund.status === 'insufficient') {
      // O site recusou o crédito por defeito de contrato: repetir é
      // laço eterno. O prefixo muda, e a varredura para de pegá-la.
      const code = refund.status === 'rejected' ? refund.code : 'CREDIT_422';

      this.#finish(purchase.serverId, purchase.id, 'failed', `REFUND_REJECTED: ${code}`);
      this.#deps.logger.error(this.#logFields(purchase), 'refund refused by the wallet owner');

      return 'review';
    }

    // `unknown` e `unavailable` continuam retentáveis: a próxima
    // volta tenta de novo com a MESMA chave.
    return null;
  }

  /**
   * A compra sai do laço automático e espera gente.
   *
   * O botão continua funcionando: um humano que consertou o site ou
   * a allowlist manda tentar de novo, uma vez, sem esperar o relógio.
   */
  #giveUp(purchase: StorePurchase, reason: string): SettleOutcome {
    this.#finish(purchase.serverId, purchase.id, 'failed', `CHARGE_UNPROVABLE: ${reason}`);
    this.#deps.logger.error(
      { ...this.#logFields(purchase), reason },
      'stuck purchase left the automatic loop; needs a human',
    );

    return 'review';
  }

  /** Os campos que TODA linha de log sobre dinheiro carrega. */
  #logFields(purchase: StorePurchase): Record<string, unknown> {
    return {
      purchaseId: purchase.id,
      // Sem ela ninguém acha a linha correspondente no ledger do
      // site, e a conciliação vira busca por horário.
      reference: purchase.reference,
      steamId: purchase.steamId,
      serverId: purchase.serverId,
      total: purchase.totalPrice,
    };
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
      // A frase vem do DONO DO SALDO, crua. O agente só acrescenta
      // o caminho: inventar texto quando o site já mandou o certo
      // daria ao suporte duas versões da mesma história — e quem
      // sabe quanto falta é quem tem o dinheiro, inclusive depois
      // de uma compra feita no site enquanto o modal estava
      // aberto.
      return `${outcome.message}
Compre OzCoins no site OrigemZ.`;

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

    case 'over-limit':
      return (
        `Esta compra passa do limite de ${outcome.limit.toLocaleString('pt-BR')} OZ por vez. ` +
        'Compre em partes, ou fale com a administração.'
      );

    case 'charge-rejected':
      // Sem detalhe técnico: o jogador não resolve um 409, e o
      // código inteiro já está no log e na tela de compras presas.
      return 'A loja está com um problema. Avise a administração.';

    case 'charge-unknown':
      // NÃO convida a tentar de novo: tentar aqui é arriscar pagar
      // duas vezes. Manda CONFERIR — é a mesma escolha que o
      // plugin faz no timeout dele.
      return 'A cobrança pode ter acontecido. Confira seu saldo e seu inventário em instantes.';

    case 'store-unavailable':
      // ####  A PALAVRA "SALDO" NÃO PODE APARECER AQUI  ####
      //
      // É a razão de o desfecho existir: pareamento quebrado e
      // bolso vazio produzem o mesmo botão morto, e o jogador que
      // lê "saldo" acha que perdeu dinheiro.
      return 'A loja está indisponível agora. Tente de novo em instantes.';

    case 'already-in-flight':
      return 'Você tem uma compra em andamento. Aguarde ou confira seu inventário.';
  }
}
