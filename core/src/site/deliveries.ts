// ============================================================
//  deliveries.ts  -  o que foi comprado NO SITE chega no jogo.
//
//  ####  QUEM PUXA É O AGENTE  ####
//
//  A entrega no Rust exige o jogador ONLINE e VIVO, e só quem está
//  na máquina sabe disso. Um push do site chegaria na hora errada, e
//  não haveria lugar nenhum onde a tarefa esperasse.
//
//  ####  TRÊS DESFECHOS, E `deferred` É O QUE PRESERVA  ####
//
//    delivered  entregou. Fecha no site.
//    failed     falha DEFINITIVA. O item volta para o inventário.
//    deferred   NÃO DEU AGORA. A tarefa continua pendente.
//
//  Sem `deferred`, um item pago voltaria para `available` só porque
//  o jogador estava dormindo. "Não entreguei" e "ainda não" são
//  coisas diferentes, e a segunda não pode ser dita com a palavra da
//  primeira.
//
//  ####  A RODADA PRECISA PAGINAR  ####
//
//  O site serve só `pending`, ordenado por id ASC, e um ACK
//  `deferred` MANTÉM a tarefa em `pending`. Junte os dois: cinquenta
//  tarefas de jogadores que sumiram ocupam a primeira página por até
//  30 dias, e a tarefa nº 51 nunca é vista. Quem comprou hoje espera
//  o prazo inteiro dos que vieram antes, e o log não acusa nada.
//
//  ####  DUAS TAREFAS NÃO MEXEM NO INVENTÁRIO, E NENHUMA ESPERA  ####
//
//  O portão de presença existe porque item, kit e veículo nascem no
//  MUNDO, ao lado de um corpo. As duas tarefas de VIP não: elas são
//  uma linha na tabela do agente, e o grupo do Oxide é o reflexo
//  dela — aplicado na conexão pelo próprio OrigemZVip. Por isso
//  `vip` e `vip_revoke` pulam a presença (ver `#handle`).
//
//  `vip_revoke` — o estorno, o chargeback, o ban e o vencimento que
//  o site varre a cada minuto — difere ainda numa segunda coisa:
//  ele REEXECUTA depois de uma linha órfã, porque tirar duas vezes
//  não tira nada na segunda (`#handle`, o bloco (a)).
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` para a fila em silêncio.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §5.7, §5.8 e §10.
// ============================================================

import { z } from 'zod';

import type { SiteDeliveriesRepository, SiteDeliveryKind } from '../db/site-deliveries-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { DeliveryPlan } from '../store/service.js';
import { toError } from '../util.js';
import type { DeliveryAck, SiteClient } from './client.js';

/**
 * Quantas tarefas cabem numa página.
 *
 * O site aceita até 100 e CLAMPA o que passar — nunca recusa —, mas
 * 50 é o que o agente pede: é o mesmo teto do lote de ACK, então
 * cada página vira exatamente um `POST /deliveries/ack`.
 */
const DELIVERY_PAGE_LIMIT = 50;

/**
 * Quantas páginas uma rodada varre antes de parar e guardar o lugar.
 *
 * ####  ELE NÃO É VARIÁVEL DE AMBIENTE  ####
 *
 * Ele é derivado do rate limit do SITE, e não do gosto de quem
 * opera: 5 páginas × (1 GET + 1 ACK) × 4 rodadas por minuto = 40
 * req/min, que somados ao pico do settler e ao espelho ficam dentro
 * do teto por servidor. Subi-lo sem subir o teto do outro lado troca
 * fila parada por 429 no meio da varredura.
 */
const DELIVERY_MAX_PAGES_PER_ROUND = 5;

export const DEFAULT_DELIVERY_POLL_MS = 15_000;
/** Dez pessoas entrando juntas não abrem dez rodadas. */
export const WAKE_DEBOUNCE_MS = 2_000;

/**
 * O que MELHORA SOZINHO. Tudo o que não está aqui é `failed`.
 *
 * O default é `failed` de propósito: ele devolve o item para
 * `available` e o jogador resgata de novo — ruim, mas visível. Um
 * `deferred` errado deixa a tarefa presa e invisível até o TTL.
 */
const DEFERRABLE = new Set([
  // Os do `origemz.give` (core/src/kits/service.ts:646-667).
  'PLAYER_NOT_FOUND',
  'PLAYER_DEAD',
  'PLAYER_SLEEPING',
  'INVENTORY_FULL',
  'DROP_FAILED',
  // Os do agente, antes do comando.
  'PLAYER_OFFLINE',
  'PRESENCE_UNAVAILABLE',
  'RCON_UNAVAILABLE',
  // O veículo que não cabe onde ele está: ele sai da base e volta.
  'VEHICLE_NO_SPACE',
]);

/**
 * O erro de uma entrega vira um dos três ACKs.
 *
 * ####  O CÓDIGO VEM DO `ApiError`, NÃO DA MENSAGEM  ####
 *
 * `RCON_UNAVAILABLE` é o caso que ensina isto: quando o RCON está
 * fora, a entrega fala com o `disconnectedRcon`, que rejeita com um
 * `ApiError` cujo `.message` é a FRASE EM PORTUGUÊS. Quem ler
 * `error.message` classifica isso como falha desconhecida e manda
 * `failed` DEFINITIVO: o item pago volta ao inventário porque o RCON
 * piscou.
 *
 * Por isso a ordem é: `ApiError.code` primeiro, mensagem depois.
 */
export function ackOf(error: unknown): {
  readonly status: 'failed' | 'deferred';
  readonly reason: string;
} {
  const code = error instanceof ApiError ? error.code : toError(error).message;
  // A entrega prefixa o código do plugin de veículo com `VEHICLE_`.
  // `VEHICLE_NO_SPACE` está no set; o resto é falha definitiva.
  const reason = code.slice(0, 200);

  return DEFERRABLE.has(reason) ? { status: 'deferred', reason } : { status: 'failed', reason };
}

// ============================================================
//  O VOCABULÁRIO DA FILA
//
//  Payload que não passar aqui NÃO é executado: vira ACK `failed`
//  com `PAYLOAD_INVALID`, e o item volta para `available` no site. É
//  melhor o jogador resgatar de novo do que o agente adivinhar o que
//  o site quis dizer.
// ============================================================

const itemSchema = z.object({
  shortname: z
    .string()
    .trim()
    // Vai para a linha de comando do console: um espaço aqui fatiaria
    // o comando.
    .regex(/^[A-Za-z0-9._-]+$/)
    .max(64),
  amount: z.number().int().min(1).max(100_000),
  /**
   * STRING, e não number: skin de workshop passa de 2^53 e voltaria
   * ARREDONDADA — o jogador receberia a arma com outra skin, ou com
   * nenhuma, sem erro em lugar nenhum.
   */
  skinId: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .max(20)
    .default('0'),
});

const payloadSchemas = {
  // Um `item` com dois itens é um kit mal cadastrado.
  item: z.object({ items: z.array(itemSchema).length(1) }),
  // 40 é o teto de um inventário que ainda cabe.
  kit: z.object({ items: z.array(itemSchema).min(1).max(40) }),
  vip: z.object({
    tier: z.string().trim().min(1).max(32),
    // Dez anos é o teto que separa "vitalício" de dedo escorregado.
    days: z.number().int().min(1).max(3650).nullable(),
  }),
  /**
   * TIRAR o VIP. Não entrega nada, e por isso não vira `DeliveryPlan`.
   *
   * ####  O `tier` É OBRIGATÓRIO, E ISSO É O CONTRATO  ####
   *
   * "Revogue o VIP dele", sem dizer qual, apagaria um VIP PAGO no
   * dia em que o jogador tivesse dois: o site manda tirar o
   * `bronze` que ele estornou, e o agente tiraria o `gold` que ele
   * comprou in-game. Tier que o jogador não tem é no-op — ver
   * `#revokeVip`.
   */
  vip_revoke: z.object({ tier: z.string().trim().min(1).max(32) }),
  vehicle: z.object({
    /**
     * O nome curto (`minicopter`) OU o exato (`sedantest.entity`).
     *
     * ####  O PONTO É LEGAL, E ISSO FOI MEDIDO  ####
     *
     * O plugin compara contra o basename sem a extensão, em duas
     * passadas: exato e `needle + ".entity"`. Proibir o ponto
     * proibiria junto o nome EXATO — que é a ferramenta que existe
     * para o caso caro: `sedan` resolve para `sedanrail.entity`, o
     * vagão de trilho, e o jogador paga por um carro que nasce e não
     * serve para nada.
     *
     * O que continua proibido é a barra (a pasta é cortada antes da
     * comparação) e o sufixo `.prefab` (a extensão também é).
     */
    prefab: z
      .string()
      .trim()
      .regex(/^[a-z0-9._-]{1,64}$/)
      .refine((value) => !value.endsWith('.prefab'), {
        message: 'o prefab não leva a extensão .prefab',
      }),
    /**
     * Quanto o SITE pediu. Ausente é legítimo, e vira zero.
     *
     * ####  EXIGIR O CAMPO SERIA PIOR DO QUE NÃO TER  ####
     *
     * Obrigatório, um payload sem `fuel` reprovava no schema e a
     * entrega inteira ACKava `PAYLOAD_INVALID`: o jogador pagava no
     * site e não recebia veículo nenhum. Zero aqui não deixa o
     * veículo seco — a entrega troca o zero por
     * `DEFAULT_VEHICLE_FUEL`; o campo só serve para o site pedir
     * outro tanto.
     */
    fuel: z.number().int().min(0).max(1000).default(0),
  }),
} as const;

export interface DeliveryTask {
  readonly id: string;
  readonly steamId: string;
  readonly kind: SiteDeliveryKind;
  readonly payload: unknown;
  readonly sourceRef: string | null;
}

/**
 * Os kinds que ENTREGAM alguma coisa.
 *
 * `vip_revoke` fica de fora de propósito: quem o tratasse como
 * plano acabaria montando um `DeliveryPlan` sem `days`, e o
 * compilador não teria como avisar. Deixando-o fora, esquecer o
 * ramo da revogação vira erro de tipo em vez de VIP concedido no
 * lugar de revogado.
 */
export type DeliveredKind = Exclude<SiteDeliveryKind, 'vip_revoke'>;

/**
 * O payload de uma revogação. `null` = não passou na régua.
 *
 * O `tier` sai daqui JÁ normalizado, que é a única grafia que
 * existe no resto da cadeia — site, banco, agente e plugin.
 */
export function revokeOfPayload(payload: unknown): { readonly tier: string } | null {
  const parsed = payloadSchemas.vip_revoke.safeParse(payload);

  return parsed.success ? { tier: parsed.data.tier.toLowerCase() } : null;
}

/**
 * O vocabulário da fila vira o PLANO da entrega.
 *
 * ####  `units` É SEMPRE 1  ####
 *
 * A entrega multiplica `amount` e `days` por `units`, porque numa
 * compra in-game o jogador escolhe a quantidade. Aqui não: o
 * `amount` que veio da fila JÁ É o total, e o `days` JÁ É o prazo.
 * Passar qualquer outro valor entregaria o dobro, o triplo, o que
 * for.
 *
 * `null` = o payload não passou na régua. Quem chama ACKa `failed`
 * com `PAYLOAD_INVALID`.
 */
export function planOfPayload(kind: DeliveredKind, payload: unknown): DeliveryPlan | null {
  const parsed = payloadSchemas[kind].safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  if (kind === 'item' || kind === 'kit') {
    const { items } = parsed.data as z.infer<typeof payloadSchemas.kit>;

    return {
      // O `itemId` é do desenho do CUI, e a fila não o manda: a
      // entrega não precisa dele — quem desenha é a loja.
      items: items.map((item) => ({ ...item, itemId: 0 })),
      vehicle: null,
      vip: null,
      units: 1,
    };
  }

  if (kind === 'vehicle') {
    const vehicle = parsed.data as z.infer<typeof payloadSchemas.vehicle>;

    return { items: [], vehicle, vip: null, units: 1 };
  }

  const vip = parsed.data as z.infer<typeof payloadSchemas.vip>;

  return {
    items: [],
    vehicle: null,
    // `days` é o vocabulário do site e `expiresAt` é o do VipList: a
    // tradução acontece AQUI, na fronteira, e não lá dentro.
    vip: { tier: vip.tier, days: vip.days },
    units: 1,
  };
}

export interface SiteDeliveriesOptions {
  readonly client: SiteClient;
  readonly repository: SiteDeliveriesRepository;
  /** O servidor LOCAL que recebe: esta fila é a dele. */
  readonly serverId: string;
  /** `null` = não deu para perguntar, e é DIFERENTE de lista vazia. */
  readonly presence: (serverId: string) => Promise<readonly string[] | null>;
  /** O MESMO caminho de entrega da compra in-game, e não um segundo. */
  readonly deliver: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly plan: DeliveryPlan;
  }) => Promise<void>;
  /**
   * Quem sabe TIRAR o VIP.
   *
   * Ausente = este agente não tem o concessor ligado, e a
   * revogação falha com o MESMO `VIP_GRANTER_UNAVAILABLE` que a
   * concessão usaria: é configuração faltando, e o site precisa
   * saber que não foi feito.
   *
   * Ela não recebe `serverId` porque o VIP não tem um: a tabela é
   * do AGENTE e vale em todos os servidores dele.
   */
  readonly revokeVip?:
    | ((input: { readonly steamId: string; readonly tier: string }) => Promise<void>)
    | undefined;
  readonly logger: Logger;
  readonly pollMs?: number;
  readonly now?: () => number;
}

export class SiteDeliveries {
  readonly #options: SiteDeliveriesOptions;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastWakeAt = 0;
  /**
   * Onde a próxima rodada do RELÓGIO recomeça.
   *
   * `null` = do topo. Preenchido quando uma rodada bateu no teto de
   * páginas — e é ele que impede a inanição da cauda: sem guardar o
   * lugar, toda rodada varreria as mesmas 250 primeiras tarefas e a
   * de nº 251 continuaria invisível.
   *
   * Zerado em três situações: `next: null` (acabou a fila), `wake()`
   * (alguém conectou, e a tarefa dele está na CABEÇA da fila) e
   * `400 INVALID_CURSOR` (o site não reconhece mais este cursor).
   */
  #cursor: string | null = null;

  constructor(options: SiteDeliveriesOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(
      () => {
        void this.poll();
      },
      this.#options.pollMs ?? DEFAULT_DELIVERY_POLL_MS,
    );
    this.#timer.unref();

    void this.poll();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Alguém CONECTOU: puxa agora, do TOPO.
   *
   * Não é detalhe: a cabeça da fila é onde moram as tarefas adiadas
   * com `PLAYER_OFFLINE`, e acabou de entrar exatamente uma das
   * pessoas que faltavam. Continuar do meio da varredura entregaria
   * a tarefa dele quando a volta chegasse lá — que é o atraso que
   * este gancho existe para não ter.
   */
  wake(): void {
    const now = this.#now();

    if (now - this.#lastWakeAt < WAKE_DEBOUNCE_MS) {
      return;
    }

    this.#lastWakeAt = now;
    this.#cursor = null;
    void this.poll();
  }

  /**
   * Uma rodada, caminhando pelas páginas até `next === null` ou até
   * o teto.
   *
   * Nunca lança.
   */
  async poll(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      let cursor = this.#cursor;
      let retriedCursor = false;

      for (let page = 0; page < DELIVERY_MAX_PAGES_PER_ROUND; page += 1) {
        const result = await this.#options.client.pendingDeliveries(
          DELIVERY_PAGE_LIMIT,
          cursor ?? undefined,
        );

        if (!result.ok) {
          // ####  `INVALID_CURSOR` NÃO É "SITE INDISPONÍVEL"  ####
          //
          // Tratá-lo como retentável repetiria o MESMO cursor
          // recusado a cada 15 s, para sempre — e como a rodada morre
          // no primeiro request, nenhuma tarefa seria entregue nesse
          // meio tempo. A fila para inteira, em silêncio, por um
          // cursor velho.
          //
          // O cursor deixa de resolver quando a tarefa que o gerou
          // saiu de `pending`: é um estado ESPERADO, não um acidente.
          if (result.code === 'INVALID_CURSOR' && !retriedCursor) {
            this.#options.logger.warn(
              { serverId: this.#options.serverId },
              'the site rejected the delivery cursor; restarting the round from the top',
            );
            retriedCursor = true;
            cursor = null;
            this.#cursor = null;
            continue;
          }

          this.#options.logger.warn(
            { serverId: this.#options.serverId, status: result.status, code: result.code },
            'could not read the delivery queue',
          );

          return;
        }

        const tasks = result.body.deliveries ?? [];
        const acks: DeliveryAck[] = [];

        for (const raw of tasks) {
          const ack = await this.#handle(raw);

          if (ack !== null) {
            acks.push(ack);
          }
        }

        await this.#ack(acks);

        const next = result.body.next ?? null;

        if (next === null) {
          // Acabou a fila: a próxima rodada começa do topo.
          this.#cursor = null;

          return;
        }

        cursor = next;
        // Guarda a cada página: se o processo morrer no meio, a
        // rodada seguinte continua daqui em vez de recomeçar.
        this.#cursor = next;
      }
    } catch (error) {
      this.#options.logger.error(
        { serverId: this.#options.serverId, err: toError(error) },
        'delivery round failed',
      );
    } finally {
      this.#running = false;
    }
  }

  /** Uma tarefa. `null` = ela não produz ACK nesta rodada. */
  async #handle(raw: {
    readonly id?: string;
    readonly steamId?: string;
    readonly kind?: string;
    readonly payload?: unknown;
    readonly sourceRef?: string | null;
  }): Promise<DeliveryAck | null> {
    const at = new Date(this.#now()).toISOString();
    const id = typeof raw.id === 'string' ? raw.id : '';
    const steamId = typeof raw.steamId === 'string' ? raw.steamId : '';
    const kind = raw.kind as SiteDeliveryKind | undefined;

    if (id === '' || !/^\d{17}$/.test(steamId) || kind === undefined || !(kind in payloadSchemas)) {
      // Uma tarefa que nem dá para identificar não vira ACK: sem id,
      // não há a quem responder.
      this.#options.logger.error({ raw }, 'the site sent a delivery task we cannot read');

      return id === ''
        ? null
        : { id, status: 'failed', reason: 'PAYLOAD_INVALID', at };
    }

    // ---- (a) já conhecemos esta tarefa? ----
    const known = this.#options.repository.get(id);

    if (known !== null) {
      if (known.state === 'delivered' || known.state === 'failed') {
        // ReACKar é de propósito: reenviar um desfecho já enviado não
        // muda nada no site, e é isso que torna seguro repetir um
        // lote depois de um timeout.
        return { id, status: known.state, ...(known.reason === null ? {} : { reason: known.reason }), at };
      }

      if (known.state === 'expired') {
        // A tarefa não é mais nossa.
        return null;
      }

      // `reserved` | `indeterminate`
      //
      // ####  A REVOGAÇÃO É A ÚNICA QUE REEXECUTA  ####
      //
      // O medo do indeterminado é ENTREGAR DUAS VEZES. Tirar o VIP
      // duas vezes não tira nada na segunda: ou o estado desejado
      // ("ele não tem mais") já vale, ou não valia — e repetir
      // chega nele nos dois casos. Mandar esta para conferência
      // humana deixaria de pé, até alguém olhar, um VIP que o site
      // já estornou.
      if (kind !== 'vip_revoke') {
        if (known.state === 'reserved') {
          // O processo morreu entre a reserva e o desfecho: o comando
          // PODE ter saído. Reexecutar entregaria duas vezes.
          this.#options.repository.finish(id, 'indeterminate', 'AGENT_INDETERMINATE', this.#now());
        }

        return { id, status: 'deferred', reason: 'AGENT_INDETERMINATE', at };
      }
    }

    // ---- (b) o payload passa na régua? ----
    if (kind === 'vip_revoke') {
      return await this.#revokeVip({ id, steamId, raw, reopen: known !== null, at });
    }

    const plan = planOfPayload(kind, raw.payload);

    if (plan === null) {
      return { id, status: 'failed', reason: 'PAYLOAD_INVALID', at };
    }

    // ---- (c) e (d) o RCON e a presença ----
    //
    // ####  SÓ QUEM TOCA O INVENTÁRIO ESPERA O JOGADOR  ####
    //
    // Item, kit e veículo nascem NO MUNDO, ao lado de um corpo que
    // precisa estar lá. VIP não: ele é uma linha na tabela do
    // agente, e o grupo do Oxide é o REFLEXO dela. Quem aplica o
    // grupo de quem estava fora é o `OnPlayerConnected` do
    // OrigemZVip (`Plugins/OrigemZVip.cs:191`), que compara o
    // jogador com o estado que o agente já empurrou.
    //
    // Esperar aqui custava caro e calado: o VIP comprado ficava
    // `deferred` no site, invisível na tela de VIPs do painel, até
    // o jogador entrar — e se ele demorasse mais que o TTL de 30
    // dias, o site devolvia ao inventário um VIP pago. Enquanto
    // isso o prazo do grant de lá corria, e os dois lados
    // divergiam desde o primeiro dia.
    //
    // Conceder na hora também é o que ALINHA os prazos: o
    // `expires_at` do site nasce no resgate, e é de lá que os 30
    // dias contam nos dois bancos.
    if (kind !== 'vip') {
      const online = await this.#options.presence(this.#options.serverId);

      if (online === null) {
        // NADA é tentado às cegas: "não deu para perguntar" é
        // diferente de "ele não está aqui".
        return { id, status: 'deferred', reason: 'PRESENCE_UNAVAILABLE', at };
      }

      if (!online.includes(steamId)) {
        return { id, status: 'deferred', reason: 'PLAYER_OFFLINE', at };
      }
    }

    // ---- (e) a RESERVA, antes de qualquer comando ----
    const reserved = this.#options.repository.reserve(
      {
        id,
        serverId: this.#options.serverId,
        steamId,
        kind,
        payload: JSON.stringify(raw.payload),
        sourceRef: typeof raw.sourceRef === 'string' ? raw.sourceRef : null,
      },
      this.#now(),
    );

    if (!reserved) {
      // Alguém reservou entre o `get` e o `reserve`. Não é erro: é a
      // chave primária fazendo o trabalho dela.
      return null;
    }

    // ---- (f) e (g) a entrega ----
    try {
      await this.#options.deliver({ serverId: this.#options.serverId, steamId, plan });
      this.#options.repository.finish(id, 'delivered', null, this.#now());
      this.#options.logger.info(
        {
          deliveryId: id,
          steamId,
          serverId: this.#options.serverId,
          kind,
          sourceRef: raw.sourceRef ?? null,
        },
        'delivery from the site completed',
      );

      return { id, status: 'delivered', at };
    } catch (error) {
      const { status, reason } = ackOf(error);

      if (status === 'deferred') {
        // O comando RESPONDEU que não deu: nada saiu, e repetir
        // é seguro. A reserva sai da frente para a próxima
        // rodada tentar limpo — mantê-la faria a volta seguinte
        // ler um adiamento normal como "pode ter saído".
        this.#options.repository.release(id);
      } else {
        this.#options.repository.finish(id, status, reason, this.#now());
      }

      return { id, status, reason, at };
    }
  }

  /**
   * Tirar o VIP. É a tarefa que NÃO entrega nada.
   *
   * ####  ELA NÃO PASSA PELO PORTÃO DE PRESENÇA  ####
   *
   * Entregar exige o jogador online e vivo — é o inventário dele
   * que recebe. Revogar não: quem manda no VIP é a tabela do
   * agente, e o grupo do Oxide sai quando o jogador voltar (a
   * reconciliação da conexão cuida, `vip/service.ts`). Exigir
   * presença aqui seria pior que inútil: o caso mais comum de uma
   * revogação é justamente quem parou de jogar, e a tarefa ficaria
   * `deferred` até o TTL de 30 dias enquanto o VIP estornado
   * continuava valendo.
   *
   * ####  NÃO TER O QUE TIRAR É SUCESSO  ####
   *
   * `VIP_NOT_FOUND` vira `delivered`, e não `failed`: o estado que
   * o site pediu já vale. E é o caso MAIS COMUM de todos — o
   * relógio daqui expira o VIP sozinho, quase sempre antes de a
   * varredura de lá chegar. `failed` aqui geraria alarme no
   * funcionamento normal, e o alarme que toca todo dia é o que
   * ninguém mais lê.
   *
   * Vale igual para o tier que ele não tem: `gold` ativo e
   * `bronze` revogado é NADA acontecendo, com ACK `delivered`.
   */
  async #revokeVip(input: {
    readonly id: string;
    readonly steamId: string;
    readonly raw: { readonly payload?: unknown; readonly sourceRef?: string | null };
    /** A linha já existe: é uma tentativa anterior que ficou órfã. */
    readonly reopen: boolean;
    readonly at: string;
  }): Promise<DeliveryAck | null> {
    const { id, steamId, raw, at } = input;
    const wanted = revokeOfPayload(raw.payload);

    if (wanted === null) {
      return { id, status: 'failed', reason: 'PAYLOAD_INVALID', at };
    }

    if (input.reopen) {
      // Reabre a linha da tentativa anterior. O `attempts` sobe, e é
      // por ele que se enxerga uma revogação que precisou voltar.
      this.#options.repository.finish(id, 'reserved', null, this.#now());
    } else {
      const reserved = this.#options.repository.reserve(
        {
          id,
          serverId: this.#options.serverId,
          steamId,
          kind: 'vip_revoke',
          payload: JSON.stringify(raw.payload),
          sourceRef: typeof raw.sourceRef === 'string' ? raw.sourceRef : null,
        },
        this.#now(),
      );

      if (!reserved) {
        // Alguém reservou entre o `get` e o `reserve`.
        return null;
      }
    }

    const revoke = this.#options.revokeVip;

    if (revoke === undefined) {
      this.#options.repository.finish(id, 'failed', 'VIP_GRANTER_UNAVAILABLE', this.#now());

      return { id, status: 'failed', reason: 'VIP_GRANTER_UNAVAILABLE', at };
    }

    try {
      await revoke({ steamId, tier: wanted.tier });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VIP_NOT_FOUND') {
        // O `reason` NÃO viaja: a lista do fio é fechada (Docs\20
        // §5.8), e um código fora dela apareceria cru para quem
        // está de plantão no site. Quem precisa saber que não havia
        // o que tirar lê o log.
        this.#options.repository.finish(id, 'delivered', null, this.#now());
        this.#options.logger.info(
          { deliveryId: id, steamId, serverId: this.#options.serverId, tier: wanted.tier },
          'the site asked to revoke a vip that was not active here',
        );

        return { id, status: 'delivered', at };
      }

      const { status, reason } = ackOf(error);

      if (status === 'deferred') {
        this.#options.repository.release(id);
      } else {
        this.#options.repository.finish(id, status, reason, this.#now());
      }

      return { id, status, reason, at };
    }

    this.#options.repository.finish(id, 'delivered', null, this.#now());
    this.#options.logger.info(
      {
        deliveryId: id,
        steamId,
        serverId: this.#options.serverId,
        tier: wanted.tier,
        sourceRef: raw.sourceRef ?? null,
      },
      'vip revoked by the site',
    );

    return { id, status: 'delivered', at };
  }

  /** O lote da página. Um ACK perdido custa uma volta de 15 s. */
  async #ack(acks: readonly DeliveryAck[]): Promise<void> {
    if (acks.length === 0) {
      return;
    }

    const result = await this.#options.client.ackDeliveries(acks);

    if (!result.ok) {
      // ####  NENHUM DESTES APAGA LINHA LOCAL  ####
      //
      // Enquanto o ACK não passa, a linha continua aberta e volta no
      // lote seguinte. O `INVALID_ACK_STATUS` merece `error`: ele
      // derruba os até 50 desfechos de uma vez, e o único jeito de
      // ele aparecer é alguém ter reintroduzido um quarto valor.
      const level = result.code === 'INVALID_ACK_STATUS' ? 'error' : 'warn';

      this.#options.logger[level](
        { serverId: this.#options.serverId, status: result.status, code: result.code },
        'the site refused a delivery ack batch',
      );

      return;
    }

    const now = this.#now();

    for (const ack of acks) {
      this.#options.repository.markAcked(ack.id, now);
    }

    // `unknown` NÃO significa "não aconteceu": um `delivered`
    // reACKado cai exatamente aí. Quem separa é o ESTADO LOCAL.
    this.#options.repository.settleUnknown(result.body.unknown ?? [], now);
  }
}
