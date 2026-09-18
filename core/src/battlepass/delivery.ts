// ============================================================
//  delivery.ts  -  do clique à mochila.
//
//  ####  ELE É O ADAPTADOR, E NÃO UM SEGUNDO ENTREGADOR  ####
//
//  As duas pontas já existiam e não se falavam. De um lado o
//  `BattlePassSync` pede (`BattlePassDelivery`, em game/battlepass.ts);
//  do outro o `QuestRewardService` traduz cada recompensa para quem
//  já sabe entregá-la — a loja, a carteira, os kits, o ranking, o
//  catálogo do Workshop, o passe. No meio não havia nada, e todo
//  resgate caía inteiro na caixa de pendências.
//
//  Este arquivo é esse meio. Ele NÃO entrega nada por conta
//  própria: escrever aqui uma segunda maneira de pôr uma AK na mão
//  de alguém daria dois caminhos para o mesmo prêmio, e o que
//  tivesse menos teste seria o que roda com a mochila cheia.
//
//  ------------------------------------------------------------
//  ####  PERGUNTA-SE ANTES  ####
//
//  Em 17/09/2026 um resgate de missão com a mochila cheia marcou a
//  missão como paga e não entregou nada. A resposta foi o
//  `quests/inventory-room.ts`, e a regra dele vale inteira aqui:
//  pergunta-se ao plugin se cabe ANTES de entregar, e NÃO SABER
//  (RCON fora, plugin velho, jogador morto) nunca vira "cabe".
//
//  Sem espaço, o item NÃO sai e a casa NÃO fecha: o `settle` só
//  marca `claimed` quando nada mais deve (02 §6.1), e a frase diz
//  quantos slots liberar.
//
//  ------------------------------------------------------------
//  ####  O QUE NÃO OCUPA SLOT NÃO É OBSTÁCULO  ####
//
//  Só item e kit disputam espaço na mochila — é o que o
//  `roomItemsOf` já sabe contar. OZCoin, ponto de ranking, XP do
//  passe, VIP e direito de skin não ocupam slot nenhum: a moeda
//  entra na carteira, o direito de skin libera a skin na rede
//  inteira e nada disso passa pelo inventário.
//
//  Travar o crédito dos 500 OZCoin porque uma espingarda da MESMA
//  linha não coube seria punir o jogador por um problema que não é
//  dele — e é o contrário do que o 02 §6.3 estabelece.
//
//  ------------------------------------------------------------
//  ####  O LOTE É PARCIAL POR NATUREZA  ####
//
//  O `claimAll` vira uma chamada DESTE arquivo por nível, e cada
//  uma pergunta o espaço de novo — porque a mochila mudou depois da
//  anterior. Cabendo 6 de 17, entregam-se as 6 e as 11 continuam
//  esperando na caixa, cada uma com o código cru do que houve.
//
//  Dentro de um nível o corte é por TIPO, e não por item: o
//  `origemz.give.check` responde sobre o conjunto ("cabe" / "faltam
//  3 slots"), e não diz quais peças caberiam. Entregar "metade dos
//  itens" exigiria adivinhar isso — e o palpite errado derrama no
//  chão, que é exatamente o que a pergunta existe para evitar.
//
//  ------------------------------------------------------------
//  ####  A CHAVE DO RETRY É (RESGATE, POSIÇÃO)  ####
//
//  O `claimId` é único e o resgate de um nível acontece UMA vez, e
//  por isso a tentativa é sempre 1: a referência da carteira e o
//  `eventId` do ponto e do XP ficam ESTÁVEIS entre o resgate e a
//  reentrega da caixa — que é o que faz o site responder
//  `idempotent` em vez de creditar duas vezes.
//
//  A posição NUNCA é renumerada: ela compõe essa chave, e filtrar a
//  lista antes de entregar quebraria a proteção exatamente no
//  caminho do retry (`quests/rewards.ts:181`). Quem pula é o `only`.
//
//  Ver Docs/BattlePass/02-O-PASSE-DO-JOGADOR.md §6.
// ============================================================

import type { BattlePassDelivery } from '../game/battlepass.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import {
  checkInventoryRoom,
  InventoryCheckError,
  roomItemsOf,
  type RoomItem,
} from '../quests/inventory-room.js';
import type { QuestRewardService } from '../quests/rewards.js';
import type { BattlePassLane, DeliveryOutcome } from '../types/battlepass.js';
import type { QuestReward } from '../types/quests.js';
import { toError } from '../util.js';

/**
 * O escopo desta entrega, dentro do `QuestRewardService`.
 *
 * Ele muda três coisas, e nenhuma é o caminho da entrega: a
 * referência da carteira, o `eventId` do ponto e a palavra que o
 * jogador lê no extrato — "Passe: Nível 13 (grátis)", e não
 * "Quest: Nível 13".
 */
export const BATTLEPASS_DELIVERY_SCOPE = 'passe';

/**
 * A tentativa, sempre 1.
 *
 * Um nível se resgata uma vez só, e o `claimId` já é único. Manter
 * o número fixo é o que deixa a chave do retry estável — ver o
 * cabeçalho.
 */
const SINGLE_ATTEMPT = 1;

/**
 * O teto do código que vai para a caixa.
 *
 * O `InventoryCheckError` carrega motivos longos ("resposta ilegível
 * do origemz.give.check: ..."), e a coluna guarda um código, não um
 * parágrafo.
 */
const MAX_CODE_CHARS = 120;

export interface BattlePassDeliveryDeps {
  /** Quem TRADUZ a recompensa para quem já sabe entregá-la. */
  readonly rewards: QuestRewardService;
  /** O RCON daquele servidor. `null` = ele está parado. */
  readonly rconOf: (serverId: string) => OpsRcon | null;
  /**
   * Os itens de um kit, pelo slug. `null` = kit que não existe mais.
   *
   * O kit entra na conta de espaço com TODOS os itens dele. Ver
   * `roomItemsOf`.
   */
  readonly kitItemsOf: (slug: string) => readonly RoomItem[] | null;
  readonly logger?: Logger | undefined;
}

/** Uma posição que NÃO vai ser entregue agora, e o porquê. */
interface BlockedReward {
  /** O código cru, que é o que o painel lê para decidir o retry. */
  readonly code: string;
  /** A frase do jogador. Português, e acionável. */
  readonly message: string;
}

/** Como a faixa aparece no extrato do jogador. */
export function laneLabel(lane: BattlePassLane): string {
  return lane === 'paid' ? 'paga' : 'grátis';
}

/** "Nível 13 (grátis)". É o que o jogador lê no extrato da carteira. */
export function claimTitle(level: number, lane: BattlePassLane): string {
  return `Nível ${String(level)} (${laneLabel(lane)})`;
}

/**
 * A frase que diz quantos slots faltam.
 *
 * Ela NÃO é a `inventoryFullMessage` das missões, de propósito:
 * aquela termina em "tente resgatar novamente", e aqui o resgate JÁ
 * aconteceu — a casa virou `pending` e um segundo clique é recusado
 * com "Você já resgatou o nível 13". O que ele tem a fazer é abrir
 * espaço; o prêmio está guardado na caixa.
 */
export function missingRoomMessage(missingSlots: number): string {
  const slots = missingSlots === 1 ? '1 slot' : `${String(missingSlots)} slots`;

  return `Libere ${slots} na mochila para receber o que ficou na caixa.`;
}

export class BattlePassDeliveryService implements BattlePassDelivery {
  readonly #deps: BattlePassDeliveryDeps;

  constructor(deps: BattlePassDeliveryDeps) {
    this.#deps = deps;
  }

  /**
   * Entrega o que o resgate prometeu, posição a posição.
   *
   * NUNCA lança: quem chamou já gravou o resgate, e uma exceção aqui
   * deixaria um `claim` sem desfecho nenhum — nem entregue, nem na
   * caixa. Toda falha vira um `DeliveryOutcome` com o código cru.
   */
  async deliver(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly claimId: number;
    readonly level: number;
    readonly lane: BattlePassLane;
    readonly rewards: readonly QuestReward[];
  }): Promise<readonly DeliveryOutcome[]> {
    try {
      return await this.#deliver(input);
    } catch (cause) {
      const error = toError(cause);

      this.#deps.logger?.error(
        { server: input.serverId, steamId: input.steamId, claimId: input.claimId, err: error },
        'a entrega do passe falhou inteira; o resgate fica na caixa',
      );

      // Tudo devendo, e com o motivo: o resgate continua `pending` e
      // o painel sabe o que reentregar.
      return input.rewards.map((_reward, idx) => ({
        idx,
        ok: false,
        code: shortCode(error.message),
      }));
    }
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  async #deliver(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly claimId: number;
    readonly level: number;
    readonly lane: BattlePassLane;
    readonly rewards: readonly QuestReward[];
  }): Promise<readonly DeliveryOutcome[]> {
    const blocked = await this.#blocked(input);
    const only = new Set<number>();

    for (const [idx] of input.rewards.entries()) {
      if (!blocked.has(idx)) only.add(idx);
    }

    // ####  A LISTA NÃO É FILTRADA; O `only` É QUE PULA  ####
    //
    // Encurtar `rewards` renumeraria o que sobrou, e o índice compõe
    // a referência da carteira e o `eventId` do ponto.
    const delivered =
      only.size === 0
        ? []
        : await this.#deps.rewards.deliver({
            only,
            serverId: input.serverId,
            steamId: input.steamId,
            questId: String(input.claimId),
            scope: BATTLEPASS_DELIVERY_SCOPE,
            attempt: SINGLE_ATTEMPT,
            questTitle: claimTitle(input.level, input.lane),
            rewards: input.rewards,
          });

    const byIndex = new Map(
      delivered.filter((outcome) => outcome.index !== undefined).map((o) => [o.index as number, o]),
    );
    const outcomes: DeliveryOutcome[] = [];

    for (const [idx] of input.rewards.entries()) {
      const stop = blocked.get(idx);

      if (stop !== undefined) {
        outcomes.push({ idx, ok: false, code: stop.code, message: stop.message });
        continue;
      }

      const done = byIndex.get(idx);

      if (done === undefined) {
        // Nenhum caminho conhecido chega aqui: o `only` pediu a
        // posição e o tradutor devolve uma por pedido. Devolver
        // "entregue" no escuro seria o "cabe" errado de novo.
        outcomes.push({ idx, ok: false, code: 'BATTLEPASS_DELIVERY_MISSING' });
        continue;
      }

      outcomes.push({ idx, ok: done.ok, code: done.code });
    }

    return outcomes;
  }

  /**
   * As posições que NÃO saem agora porque não cabem — ou porque não
   * deu para saber se cabem.
   *
   * Vazio = ou tudo cabe, ou nada ali disputa espaço.
   */
  async #blocked(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly claimId: number;
    readonly rewards: readonly QuestReward[];
  }): Promise<ReadonlyMap<number, BlockedReward>> {
    const roomIndexes = input.rewards.flatMap((reward, idx) =>
      reward.kind === 'item' || reward.kind === 'kit' ? [idx] : [],
    );

    // Só moeda, ponto, XP, VIP ou skin: nada ocupa slot, e perguntar
    // ao plugin seria uma ida ao RCON por nada.
    if (roomIndexes.length === 0) return new Map();

    const items = roomItemsOf(input.rewards, this.#deps.kitItemsOf);

    // Um kit que foi apagado depois de a temporada prometê-lo não
    // tem itens para medir. A entrega dele falha por conta própria,
    // com `KIT_NOT_FOUND`, que é o que o painel precisa ver.
    if (items.length === 0) return new Map();

    let missingSlots: number;

    try {
      const room = await checkInventoryRoom(
        this.#deps.rconOf(input.serverId),
        input.steamId,
        items,
      );

      if (room.fits) return new Map();

      // `fits: false` com `missingSlots: 0` seria um plugin se
      // contradizendo. "Libere 0 slots" não é frase; o piso de 1 é.
      missingSlots = Math.max(1, room.missingSlots);
    } catch (cause) {
      // ####  NÃO SABER NUNCA VIRA "CABE"  ####
      //
      // RCON fora, plugin velho, jogador morto: nos três o prêmio
      // fica guardado na caixa, e não derramado no chão de uma base
      // com gente em volta.
      const reason = cause instanceof InventoryCheckError ? cause.reason : toError(cause).message;
      const message =
        cause instanceof InventoryCheckError
          ? cause.message
          : 'Não deu para conferir o seu inventário agora.';

      this.#deps.logger?.warn(
        { server: input.serverId, steamId: input.steamId, claimId: input.claimId, reason },
        'não deu para conferir o espaço do inventário; o prêmio do passe fica na caixa',
      );

      return blockAll(roomIndexes, shortCode(reason), message);
    }

    return blockAll(roomIndexes, 'INVENTORY_FULL', missingRoomMessage(missingSlots));
  }
}

function blockAll(
  indexes: readonly number[],
  code: string,
  message: string,
): ReadonlyMap<number, BlockedReward> {
  return new Map(indexes.map((idx) => [idx, { code, message }]));
}

/** O código cru, no tamanho de um código. Ver `MAX_CODE_CHARS`. */
function shortCode(reason: string): string {
  return reason.slice(0, MAX_CODE_CHARS);
}
