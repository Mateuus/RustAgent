// ============================================================
//  rewards.ts  -  o que a quest DÁ, entregue por quem já sabe
//  entregar.
//
//  ####  ESTE ARQUIVO NÃO ENTREGA NADA  ####
//
//  Ele TRADUZ. As seis recompensas já existem no agente, cada uma
//  com o seu caminho testado, e nenhuma delas é reescrita aqui:
//
//    item, vip  ->  StoreService.deliverPlan   (store/service.ts)
//    coins      ->  Wallet.credit              (store/wallet.ts)
//    kit        ->  KitsService.claim          (kits/service.ts)
//    points     ->  o applyEvent do ranking    (db/rankings-repository.ts)
//    skin       ->  WorkshopCatalog.grantOwnership (game/workshop-catalog.ts)
//
//  Escrever uma segunda entrega de item aqui produziria duas
//  maneiras de pôr uma AK na mão de alguém — e a que tivesse menos
//  teste seria a que roda quando o inventário está cheio.
//
//  ------------------------------------------------------------
//  ####  UMA FALHA NÃO DERRUBA AS OUTRAS  ####
//
//  As recompensas são tentadas UMA A UMA, e o resultado de cada uma
//  volta separado. O inventário cheio faz o item falhar; os 500
//  coins da mesma quest continuam sendo creditados.
//
//  A alternativa — abortar tudo no primeiro erro — parece mais
//  segura e não é: ela transforma "faltou espaço para a AK" em
//  "não recebi nada", e o admin passa a ter de reentregar quatro
//  coisas em vez de uma.
//
//  ------------------------------------------------------------
//  ####  E ELE NÃO DECIDE SE PODE ENTREGAR  ####
//
//  Quem confere `have >= need`, marca `claimed` e COMITA é o
//  `quests/service.ts`. Quando este arquivo é chamado, a decisão já
//  foi tomada e gravada — é por isso que ele nunca lança: uma
//  exceção aqui, depois do commit, seria uma quest resgatada sem
//  nenhum registro do que deu errado.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §6.
// ============================================================

import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { buildReference } from '../store/reference.js';
import type { QuestReward } from '../types/quests.js';
import { toError } from '../util.js';

// ------------------------------------------------------------
//  §1  O QUE ELE PRECISA DOS OUTROS
//
//  Interfaces MÍNIMAS, e não os serviços inteiros: é o padrão do
//  `WalletStore` e do `UiSyncRcon`. Em produção quem as satisfaz
//  são o `StoreService`, a `Wallet`, o `KitsService` e o
//  `RankingsRepository`; no teste, quatro objetos de cinco linhas.
// ------------------------------------------------------------

/** O caminho do item e do VIP. É o `deliverPlan` da loja. */
export interface QuestItemDelivery {
  deliverPlan(
    serverId: string,
    steamId: string,
    plan: {
      readonly items: readonly {
        readonly shortname: string;
        /** Do catálogo do JOGO. O CUI e o `give` desenham por ele. */
        readonly itemId: number;
        readonly amount: number;
        readonly skinId: string;
      }[];
      readonly vehicle: null;
      readonly vip: { readonly tier: string; readonly days: number | null } | null;
      readonly units: number;
    },
  ): Promise<void>;
}

export interface QuestWallet {
  credit(input: {
    readonly steamId: string;
    readonly amount: number;
    readonly reference: string;
    readonly reason: string;
  }): Promise<{ readonly status: string; readonly message?: string; readonly reason?: string }>;
}

export interface QuestKits {
  /** O kit é achado pelo `slug`; o id é desta máquina. Ver appliers/kits.ts. */
  list(): readonly { readonly id: number; readonly slug: string; readonly name: string }[];
  claim(input: {
    readonly kitId: number;
    readonly steamId: string;
    readonly serverId: string;
    readonly actor: string | null;
  }): Promise<{ readonly status: string; readonly detail?: string | null }>;
}

/** O caminho do ponto. É o mesmo da ação `points` do item custom. */
export interface QuestPoints {
  /**
   * Aquela métrica é um ranking de verdade?
   *
   * ####  SEM ISTO, O PONTO SOME EM SILÊNCIO  ####
   *
   * MEDIDO em 06/09/2026: uma quest de teste prometia pontos em
   * `quest.completed`, que não é ranking nenhum. O `applyEvent`
   * gravava o evento sem reclamar, o resgate dizia "2 pontos", e o
   * jogador nunca via aquilo em lugar nenhum — porque não há
   * lugar.
   *
   * O `#item` já recusava um shortname fora do catálogo do jogo
   * (`ITEM_UNKNOWN`); isto é a mesma regra para o outro catálogo.
   *
   * Ausente = o serviço não sabe conferir, e paga como antes. É o
   * que mantém de pé quem monta o `QuestRewardService` sem os
   * rankings.
   */
  readonly hasMetric?: (metric: string) => boolean;
  applyEvent(input: {
    readonly eventId: string;
    readonly serverId: string;
    readonly steamId: string;
    readonly metric: string;
    readonly amount: number;
    readonly source?: string | null;
    /** Epoch em SEGUNDOS — é a unidade da coluna. Ver a migração 033. */
    readonly at: number;
    readonly via: 'push' | 'flush';
  }): { readonly applied: boolean };
}

/**
 * O catálogo do jogo, para resolver o `itemId` de um shortname.
 *
 * O plano de entrega da loja exige o id numérico — a recompensa
 * guarda só o shortname, que é o que o admin digita. Sem este
 * tradutor, o item não pode ser entregue.
 */
export interface QuestItemCatalog {
  itemIdOf(shortname: string): number | null;
}

/**
 * O pedido de posse, como ESTE arquivo o monta.
 *
 * É um subconjunto do `GrantOwnershipRequest` do catálogo: a quest
 * nunca manda data absoluta (`expiresAt`) nem nota, e a origem é
 * sempre `system` — quem decidiu foi o agente, e não o painel, o
 * site ou o admin no jogo.
 */
export interface QuestSkinGrant {
  readonly steamId: string;
  /** O `id` da skin NESTE agente, achado pela marca. */
  readonly skinRef: number;
  /** `null` = permanente. Preenchido, SOMA ao prazo vivo. */
  readonly days: number | null;
  readonly source: 'system';
  /** `quest:<id>:<tentativa>:<posição>`. Vai para o registro. */
  readonly sourceRef: string;
  /** Quem deu: `quest:<id>`, `koth:<id>`. */
  readonly createdBy: string;
  readonly serverId: string;
}

/**
 * O caminho da skin. É o `WorkshopCatalog`, e não o repositório.
 *
 * ####  PELO CATÁLOGO, PORQUE ELE AVISA  ####
 *
 * `WorkshopOwnedRepository.grantOwnership` grava e pronto. Quem
 * REGISTRA a concessão e reenvia a posse para o jogador online é o
 * catálogo — sem esse aviso a skin existe no banco e não aparece no
 * menu de quem está jogando até ele reconectar.
 *
 * A skin é achada pela MARCA `(shortname, workshopId)`, como na
 * entrega do site: o `id` interno não viaja para fora do agente.
 */
export interface QuestSkins {
  findSkinByMark(
    shortname: string,
    workshopId: string,
  ): { readonly id: number; readonly label: string } | null;
  grantOwnership(
    request: QuestSkinGrant,
    now?: number,
  ): { readonly owned: { readonly expiresAt: number | null } };
}

export interface QuestRewardDeps {
  readonly logger: Logger;
  /**
   * Ausentes = aquele tipo de recompensa não pode ser entregue
   * NESTE agente, e falha com um código que diz isso.
   *
   * `undefined` e não um dublê silencioso: uma quest que promete
   * kit num agente sem `kits` precisa aparecer como pendência no
   * painel, não sumir como se tivesse sido entregue.
   */
  readonly delivery?: QuestItemDelivery;
  readonly catalog?: QuestItemCatalog;
  readonly wallet?: (serverId: string) => QuestWallet;
  readonly kits?: QuestKits;
  readonly points?: QuestPoints;
  readonly skins?: QuestSkins;
  readonly now?: () => number;
}

// ------------------------------------------------------------
//  §2  O DESFECHO
// ------------------------------------------------------------

export interface RewardOutcome {
  /**
   * A POSIÇÃO da recompensa no snapshot.
   *
   * Opcional porque nem todo caminho que monta um desfecho passa
   * pelo loop (o serviço monta os seus quando não há entregador).
   * Quem grava o registro por posição preenche.
   */
  readonly index?: number;
  readonly kind: QuestReward['kind'];
  readonly ok: boolean;
  /** O que o jogador lê. Português, sempre preenchido. */
  readonly message: string;
  /** O código cru, para o painel e para o log. `null` quando deu certo. */
  readonly code: string | null;
}

export interface DeliverRewardsInput {
  /**
   * Só estas POSIÇÕES da lista. Ausente = todas.
   *
   * É o que o botão de reentregar manda: as que falharam. Sem isto
   * ele reprocessava todas, e item, kit, VIP e skin saíam de novo —
   * moeda e ponto escapavam por acaso, pela idempotência que os
   * dois têm na ponta.
   *
   * Na skin o estrago é o prazo: dar de novo uma posse viva SOMA os
   * dias (ver `renewedExpiry`), e reprocessar uma que já saiu dobra
   * o prazo em silêncio — ninguém reclama de ganhar mais.
   */
  readonly only?: ReadonlySet<number>;
  readonly serverId: string;
  readonly steamId: string;
  readonly questId: string;
  /**
   * De QUEM é esta entrega. `quest`, se ninguém disser.
   *
   * ####  ELE EXISTE PORQUE O KOTH PAGA PELO MESMO CAMINHO  ####
   *
   * Este serviço não entrega nada: ele traduz para quem já sabe
   * entregar. Isso vale para qualquer coisa que prometa um prêmio,
   * e o KOTH é a segunda — escrever uma segunda tradução daria dois
   * jeitos de pôr uma AK na mão de alguém.
   *
   * O escopo muda três coisas, e nenhuma delas é o caminho da
   * entrega: a referência da carteira, o `eventId` do ponto e a
   * palavra que o jogador lê no extrato. Sem ele, um KOTH pago
   * apareceria como "Quest: Colina do Norte".
   */
  readonly scope?: string;
  /** Qual tentativa. Entra na referência da carteira e no id do ponto. */
  readonly attempt: number;
  readonly questTitle: string;
  readonly rewards: readonly QuestReward[];
  /**
   * A distância que o AGENTE mediu entre os dois NPCs da entrega.
   *
   * Nunca a que o plugin mandou: um cliente que dissesse ter
   * andado 40 km pagaria 40 km. Ausente em toda quest que não é de
   * entrega, e a recompensa `perMeter` falha sem ela — em vez de
   * pagar zero em silêncio.
   */
  readonly distanceMeters?: number;
}

// ------------------------------------------------------------
//  §3  O SERVIÇO
// ------------------------------------------------------------

/**
 * A palavra do extrato, a partir do escopo.
 *
 * O jogador lê isto na carteira; "koth" em minúsculas ficaria do
 * lado de "Quest: Caçador" e pareceria defeito.
 */
function scopeLabel(scope: string): string {
  if (scope === 'quest') return 'Quest';

  if (scope === 'koth') return 'KOTH';

  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

export class QuestRewardService {
  readonly #deps: QuestRewardDeps;

  constructor(deps: QuestRewardDeps) {
    this.#deps = deps;
  }

  /**
   * Entrega tudo o que a quest prometeu.
   *
   * NUNCA lança: quem chamou já comitou o `claimed`, e uma exceção
   * aqui deixaria a quest resgatada sem registro do que deu errado.
   * Toda falha vira um `RewardOutcome` com `ok: false` e um código.
   */
  async deliver(input: DeliverRewardsInput): Promise<readonly RewardOutcome[]> {
    const outcomes: RewardOutcome[] = [];

    for (const [index, reward] of input.rewards.entries()) {
      // ####  A LISTA NÃO É FILTRADA; O LOOP É QUE PULA  ####
      //
      // Filtrar `rewards` antes renumeraria o que sobrou — e o
      // índice não é enfeite: ele compõe a `reference` da carteira e
      // o `eventId` do ranking. Renumerar faria a segunda entrega
      // parecer outra, e a proteção contra pagar duas vezes cairia
      // justamente no caminho do retry.
      if (input.only !== undefined && !input.only.has(index)) {
        continue;
      }

      outcomes.push({ ...(await this.#one(input, reward, index)), index });
    }

    const failed = outcomes.filter((item) => !item.ok);

    if (failed.length > 0) {
      this.#deps.logger.warn(
        {
          steamId: input.steamId,
          serverId: input.serverId,
          questId: input.questId,
          attempt: input.attempt,
          failed: failed.map((item) => ({ kind: item.kind, code: item.code })),
        },
        'recompensa de quest não saiu',
      );
    }

    return outcomes;
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  async #one(
    input: DeliverRewardsInput,
    reward: QuestReward,
    index: number,
  ): Promise<RewardOutcome> {
    try {
      switch (reward.kind) {
        case 'item':
          return await this.#item(input, reward);
        case 'vip':
          return await this.#vip(input, reward);
        case 'coins':
          return await this.#coins(input, reward, index);
        case 'kit':
          return await this.#kit(input, reward);
        case 'points':
          return this.#points(input, reward, index);
        case 'skin':
          return this.#skin(input, reward, index);
      }
    } catch (cause) {
      // O código CRU de quem entrega — `INVENTORY_FULL`,
      // `RCON_UNAVAILABLE` — é o que o painel precisa para saber o
      // que reentregar. Reescrevê-lo aqui produziria duas
      // explicações para o mesmo problema.
      const error = toError(cause);

      return {
        kind: reward.kind,
        ok: false,
        code: error.message,
        message: 'Não deu para entregar esta recompensa agora. Um administrador foi avisado.',
      };
    }
  }

  async #item(input: DeliverRewardsInput, reward: Extract<QuestReward, { kind: 'item' }>) {
    if (this.#deps.delivery === undefined) {
      return missing('item', 'itens');
    }

    const itemId = this.#deps.catalog?.itemIdOf(reward.shortname) ?? null;

    if (itemId === null) {
      // O shortname não está no catálogo do jogo: ou o Rust o
      // removeu numa atualização, ou o admin digitou errado. Falhar
      // aqui é o que faz isso virar pendência no painel, com o nome
      // do item — em vez de um `give` que o plugin recusa e cujo
      // motivo ninguém vê.
      return {
        kind: 'item' as const,
        ok: false,
        code: 'ITEM_UNKNOWN',
        message: `O item "${reward.shortname}" não existe mais no jogo. Um administrador foi avisado.`,
      };
    }

    await this.#deps.delivery.deliverPlan(input.serverId, input.steamId, {
      items: [
        {
          shortname: reward.shortname,
          itemId,
          amount: reward.amount,
          skinId: reward.skinId,
        },
      ],
      vehicle: null,
      vip: null,
      units: 1,
    });

    return {
      kind: 'item' as const,
      ok: true,
      code: null,
      message: `${String(reward.amount)}x ${reward.shortname} no seu inventário.`,
    };
  }

  async #vip(input: DeliverRewardsInput, reward: Extract<QuestReward, { kind: 'vip' }>) {
    if (this.#deps.delivery === undefined) {
      return missing('vip', 'VIP');
    }

    // O VIP vai pelo MESMO `deliverPlan` do item, e não por uma
    // chamada direta ao concessor: é lá que mora a conta de
    // `days x units` e o tratamento do concessor ausente. Duas
    // portas para o mesmo benefício divergiriam na primeira
    // mudança de regra do VIP.
    await this.#deps.delivery.deliverPlan(input.serverId, input.steamId, {
      items: [],
      vehicle: null,
      vip: { tier: reward.tier, days: reward.days },
      units: 1,
    });

    return {
      kind: 'vip' as const,
      ok: true,
      code: null,
      message: `VIP ${reward.tier} por ${String(reward.days)} dia(s).`,
    };
  }

  async #coins(
    input: DeliverRewardsInput,
    reward: Extract<QuestReward, { kind: 'coins' }>,
    index: number,
  ) {
    if (this.#deps.wallet === undefined) {
      return missing('coins', 'OZCoin');
    }

    const amount = this.#coinAmount(reward, input.distanceMeters);

    if (amount === null) {
      // `perMeter` sem distância medida. Pagar zero em silêncio
      // seria pior: a quest apareceria como entregue e o jogador
      // não teria o que reclamar de concreto.
      return {
        kind: 'coins' as const,
        ok: false,
        code: 'QUEST_DISTANCE_UNKNOWN',
        message: 'Não deu para medir a distância da entrega. Um administrador foi avisado.',
      };
    }

    if (amount === 0) {
      return { kind: 'coins' as const, ok: true, code: null, message: 'Sem OZCoin desta vez.' };
    }

    // ####  A REFERÊNCIA É O QUE TORNA O RETRY SEGURO  ####
    //
    // Ela nasce de (quest, tentativa, posição da recompensa), que é
    // único e ESTÁVEL: o botão de reentregar do painel manda a
    // mesma, e a carteira do site responde `idempotent` em vez de
    // creditar duas vezes. É o único dos seis tipos que tem essa
    // proteção — ver o cabeçalho de store/reference.ts.
    const scope = input.scope ?? 'quest';

    const reference = buildReference(
      input.serverId,
      scope,
      `${input.questId}:${String(input.attempt)}:${String(index)}`,
    );

    const result = await this.#deps.wallet(input.serverId).credit({
      steamId: input.steamId,
      amount,
      reference,
      reason: `${scopeLabel(scope)}: ${input.questTitle}`,
    });

    if (result.status !== 'ok') {
      return {
        kind: 'coins' as const,
        ok: false,
        code: `WALLET_${result.status.toUpperCase()}`,
        message: result.message ?? 'Não deu para creditar o OZCoin agora.',
      };
    }

    return {
      kind: 'coins' as const,
      ok: true,
      code: null,
      // A moeda da rede se chama OZCoin, e e assim que ela
      // aparece no cabecalho do menu, na loja e no site.
      message: `${amount.toLocaleString('pt-BR')} OZCoin no seu saldo.`,
    };
  }

  async #kit(input: DeliverRewardsInput, reward: Extract<QuestReward, { kind: 'kit' }>) {
    if (this.#deps.kits === undefined) {
      return missing('kit', 'kits');
    }

    const kit = this.#deps.kits.list().find((item) => item.slug === reward.slug);

    if (kit === undefined) {
      // O kit foi apagado depois de a quest prometê-lo. O snapshot
      // guardou a promessa; o kit não existe mais para cumpri-la.
      return {
        kind: 'kit' as const,
        ok: false,
        code: 'KIT_NOT_FOUND',
        message: `O kit "${reward.slug}" não existe mais. Um administrador foi avisado.`,
      };
    }

    const result = await this.#deps.kits.claim({
      kitId: kit.id,
      steamId: input.steamId,
      serverId: input.serverId,
      actor: 'quest',
    });

    if (result.status !== 'entregue') {
      return {
        kind: 'kit' as const,
        ok: false,
        code: 'KIT_NOT_DELIVERED',
        message: result.detail ?? 'Não deu para entregar o kit agora.',
      };
    }

    return { kind: 'kit' as const, ok: true, code: null, message: `Kit ${kit.name} entregue.` };
  }

  #points(
    input: DeliverRewardsInput,
    reward: Extract<QuestReward, { kind: 'points' }>,
    index: number,
  ) {
    if (this.#deps.points === undefined) {
      return missing('points', 'pontos de ranking');
    }

    // Métrica fora do catálogo: o ponto iria para uma tabela que
    // nenhuma tela lê. Falhar aqui é o que faz isso virar pendência
    // no painel, com o nome da métrica — em vez de um número que
    // some. Ver `hasMetric`.
    if (this.#deps.points.hasMetric?.(reward.metric) === false) {
      return {
        kind: 'points' as const,
        ok: false,
        code: 'RANKING_METRIC_UNKNOWN',
        message:
          `O ranking "${reward.metric}" não existe. Um administrador foi avisado.`,
      };
    }

    // ####  O `eventId` É NOSSO, E ELE É ESTÁVEL  ####
    //
    // No item custom quem gera é o plugin; aqui não há plugin no
    // caminho — o ponto nasce de uma decisão do agente. A chave é
    // (quest, tentativa, posição), a mesma da carteira: o retry do
    // painel cai no `INSERT OR IGNORE` do `applyEvent` e não soma
    // duas vezes.
    const applied = this.#deps.points.applyEvent({
      eventId: `${input.scope ?? 'quest'}:${input.questId}:${String(input.attempt)}:${String(index)}`,
      serverId: input.serverId,
      steamId: input.steamId,
      metric: reward.metric,
      amount: reward.amount,
      source: input.scope ?? 'quest',
      // Segundos: é a unidade da coluna `at` de `stat_events`, e
      // errar isso desloca o evento para 1970 sem nenhum erro no
      // caminho.
      at: Math.floor((this.#deps.now?.() ?? Date.now()) / 1000),
      via: 'push',
    }).applied;

    return {
      kind: 'points' as const,
      ok: true,
      code: null,
      // `applied: false` quer dizer "já tinha somado", e isso NÃO é
      // falha: é o retry funcionando como devia.
      message: applied
        ? `${String(reward.amount)} ponto(s) em ${reward.metric}.`
        : 'Os pontos desta quest já tinham sido somados.',
    };
  }

  #skin(
    input: DeliverRewardsInput,
    reward: Extract<QuestReward, { kind: 'skin' }>,
    index: number,
  ): RewardOutcome {
    if (this.#deps.skins === undefined) {
      return missing('skin', 'skins do Workshop');
    }

    const skin = this.#deps.skins.findSkinByMark(reward.shortname, reward.skinId);

    if (skin === null) {
      // A skin saiu do catálogo depois de a quest prometê-la. O
      // snapshot guardou a marca; não há o que liberar. O código é o
      // mesmo da entrega do site, que descobre isso pelo mesmo
      // caminho.
      return {
        kind: 'skin',
        ok: false,
        code: 'SKIN_NOT_IN_CATALOG',
        message: `A skin ${reward.skinId} em "${reward.shortname}" não está mais no catálogo. Um administrador foi avisado.`,
      };
    }

    const scope = input.scope ?? 'quest';

    try {
      // ####  A POSSE NÃO É UMA CÓPIA NA MOCHILA  ####
      //
      // Ela LIBERA a skin para o jogador na rede inteira, e nada
      // entra no inventário: não há como falhar por mochila cheia, e
      // ele a aplica quando quiser, no menu de skins.
      //
      // O prazo sai daqui em DIAS, e não em data calculada aqui:
      // quem já tem posse viva ganha a soma, e só o agente sabe
      // quanto sobrava. Ver `renewedExpiry`.
      const { owned } = this.#deps.skins.grantOwnership(
        {
          steamId: input.steamId,
          skinRef: skin.id,
          days: reward.days,
          source: 'system',
          // A mesma chave da carteira e do ponto. Aqui ela não
          // protege de nada — não há índice único atrás dela —, mas
          // é o que responde "de onde veio esta posse?" no registro.
          sourceRef: `${scope}:${input.questId}:${String(input.attempt)}:${String(index)}`.slice(
            0,
            120,
          ),
          createdBy: `${scope}:${input.questId}`.slice(0, 120),
          serverId: input.serverId,
        },
        this.#deps.now?.() ?? Date.now(),
      );

      return {
        kind: 'skin',
        ok: true,
        code: null,
        // A frase sai do prazo RESULTANTE, e não do pedido: quem já
        // tinha a skin para sempre continua com ela para sempre,
        // mesmo que esta recompensa desse 30 dias.
        message:
          reward.days === null || owned.expiresAt === null
            ? `Skin ${skin.label} liberada para sempre.`
            : `Skin ${skin.label} liberada por ${String(reward.days)} dia(s).`,
      };
    } catch (cause) {
      // O catálogo recusa com `ApiError`: o código dele já é cru
      // (`OWNED_ALREADY_EXPIRED`, `INVALID_OWNERSHIP`) e a frase já
      // está em português. O catch geral do `#one` usaria a FRASE
      // como código, e o painel mostraria uma frase onde espera um
      // código.
      if (cause instanceof ApiError) {
        return { kind: 'skin', ok: false, code: cause.code, message: cause.message };
      }

      throw cause;
    }
  }

  /**
   * Quanto pagar em moeda.
   *
   * `null` = a conta depende de uma distância que não foi medida.
   */
  #coinAmount(
    reward: Extract<QuestReward, { kind: 'coins' }>,
    distanceMeters: number | undefined,
  ): number | null {
    if (reward.amount !== null) {
      return reward.amount;
    }

    if (reward.perMeter === null) {
      return null;
    }

    if (distanceMeters === undefined || !Number.isFinite(distanceMeters)) {
      return null;
    }

    const raw = Math.round(Math.max(0, distanceMeters) * reward.perMeter);
    // O piso e o teto existem porque uma entrega entre dois NPCs
    // distantes num mapa de 6 km pagaria um número que ninguém
    // escolheu.
    const floored = reward.min === null ? raw : Math.max(reward.min, raw);

    return reward.max === null ? floored : Math.min(reward.max, floored);
  }
}

/**
 * O agente não tem por onde entregar aquilo.
 *
 * Vira pendência visível no painel, e não silêncio: uma quest que
 * promete kit num agente sem o serviço de kits precisa aparecer
 * como algo a resolver.
 */
function missing(kind: QuestReward['kind'], what: string): RewardOutcome {
  return {
    kind,
    ok: false,
    code: 'QUEST_REWARD_UNAVAILABLE',
    message: `Este agente não está entregando ${what} agora. Um administrador foi avisado.`,
  };
}
