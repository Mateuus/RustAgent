// ============================================================
//  service.ts  -  a loja: quem pode pegar o quê, e a entrega.
//
//  Um kit é um loadout com REGRAS DE ENTREGA:
//
//      resgate    N usos por jogador — 1 é o "resgate único"
//      cooldown   de N em N segundos
//
//  ####  E O USO PODE VOLTAR NO WIPE  ####
//
//  `useResetOn` move a JANELA da contagem: nada é apagado e nenhum
//  contador é zerado — `#usedIn` só passa a contar de uma data para
//  cá. Ver a migração 054.
//
//  ------------------------------------------------------------
//  ####  A ENTREGA EXIGE O JOGADOR ONLINE  ####
//
//  E isso não é limitação nossa: item entra em INVENTÁRIO, e
//  inventário só existe para quem está conectado — o Rust descarrega
//  o `BasePlayer` de quem saiu. A recusa precisa dizer isso: "entre
//  no servidor para resgatar" é acionável; "falha na entrega" não.
//
//  ####  O AGENTE ENTREGA; ELE NÃO VENDE  ####
//
//  Kit não tem preço desde a migração 052: o que se vende na rede
//  está na LOJA, com vitrine, categoria e carteira. Aqui só existem
//  as duas regras de quando se pode pegar de novo.
//
//  ####  A LINHA DO CLAIM NASCE ANTES DO COMANDO  ####
//
//  Ver kits-repository.ts: ela nasce `falhou` com "entrega
//  interrompida" e é fechada com o desfecho. Se o agente morrer no
//  meio, a linha fica com a verdade — e a entrega que travou é
//  justamente a que gera reclamação.
//
//  ####  AS PRÉ-CONDIÇÕES SÃO CONFERIDAS ANTES DE ABRIR A LINHA  ####
//
//  Jogador offline, cooldown, resgate já usado e nível insuficiente
//  NÃO viram claim: eles são recusa, não tentativa. Abrir linha para
//  eles encheria o histórico de "falhou" que não são entrega nenhuma
//  — e, no resgate único, queimaria a única chance de quem nem
//  chegou a receber.
//
//  ####  E SÓ ENTREGA CONFIRMADA CONSOME A REGRA  ####
//
//  `lastDeliveredClaim` olha apenas os `entregue`. Uma tentativa que
//  falhou no meio (o jogador saiu, o RCON caiu) não queima o resgate
//  único nem inicia o cooldown. Entrega PARCIAL conta como entregue,
//  com o detalhe dizendo o que faltou: o jogador recebeu alguma
//  coisa, e repetir daria itens em dobro.
// ============================================================

import { assertSteamId } from '../bans/service.js';
import type { KitRecord, KitsRepository } from '../db/kits-repository.js';
import type { PlayerEventInput } from '../db/players-repository.js';
import type { VipsRepository } from '../db/vips-repository.js';
import { describeGiveError, firstJsonLine } from '../game/plugin-contract.js';
import { ApiError } from '../http/error-response.js';
import type { LoadoutItem } from '../loadouts/items.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import { readVipTiers, type VipTierLevel } from '../vip/tiers.js';

/** O comando de entrega do `OrigemZAgent`. */
export const GIVE_COMMAND = 'origemz.give';

/**
 * Como o item é entregue.
 *
 * `auto` = tenta o inventário e joga no chão o que não couber. Os
 * outros dois modos do plugin (`inventory`, `drop`) existem, e não
 * são usados aqui: com `inventory`, um jogador de mochila cheia
 * receberia INVENTORY_FULL e o kit sumiria; com `drop`, um kit
 * inteiro no chão do lado de quem tem espaço é convite a perder item
 * para quem passa.
 */
const GIVE_MODE = 'auto';

/** O que a loja precisa saber dos servidores. */
export interface KitServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
  configOf(id: string): { readonly paths: { readonly oxideConfigDir: string } } | null;
}

/**
 * Quem está online NAQUELE servidor, agora.
 *
 * Interface mínima de propósito: quem a satisfaz em produção é o
 * `PlayersReader` (game/players.ts), que já sabe escolher entre o
 * plugin e o `playerlist` nativo. Perguntar ao RCON daqui seria um
 * segundo caminho para a mesma pergunta.
 *
 * `null` = não deu para perguntar — e isso é DIFERENTE de lista
 * vazia. Com `null` a entrega é recusada dizendo que não deu para
 * conferir, em vez de afirmar que o jogador está fora.
 */
export interface KitPresence {
  online(serverId: string): Promise<readonly string[] | null>;
}

/** O que a loja precisa da ficha do jogador. E nada além. */
export interface KitHistory {
  recordAction(event: PlayerEventInput): void;
}

/**
 * Quem sabe quando foi o último wipe daquele servidor.
 *
 * Interface mínima: quem a satisfaz em produção é o `WipeClock`
 * (game/wipe.ts), que pergunta ao servidor e cacheia. `null` = não
 * deu para saber — e aí o kit LIBERA, porque recusar sem certeza
 * puniria o jogador por um servidor que não respondeu.
 */
export interface KitWipeClock {
  at(serverId: string): Promise<number | null>;
  /**
   * Quando foi o último FULL WIPE daquele servidor.
   *
   * O do agente: quem responde é `wipe_runs`, e ele só conhece os
   * wipes que ELE conduziu. `null` = nenhum registrado — e aí o kit
   * que reseta no full wipe não reseta, porque resetar sem saber a
   * data daria usos infinitos. Ver a migração 054.
   *
   * Opcional para quem só precisa do bloqueio pós-wipe (os testes
   * antigos, por exemplo).
   */
  fullAt?(serverId: string): Promise<number | null>;
}

/**
 * As duas horas de wipe que a regra do kit consulta.
 *
 * Lidas UMA vez por chamada e passadas adiante: `#whyNot` roda uma
 * vez por kit da vitrine, e perguntar a hora do wipe por kit seria
 * uma ida ao RCON por linha da tela.
 */
interface WipeMoment {
  /** O wipe do servidor (`SaveCreatedTime`). */
  readonly at: number | null;
  /** O último full wipe conduzido pelo agente. */
  readonly fullAt: number | null;
}

export interface KitStoreDeps {
  readonly repository: KitsRepository;
  readonly vips: VipsRepository;
  readonly servers: KitServers;
  readonly presence: KitPresence;
  readonly logger: Logger;
  readonly history?: KitHistory | undefined;
  /** Ausente = nenhum kit é bloqueado por wipe. */
  readonly wipe?: KitWipeClock | undefined;
}

/** Um kit como a API o mostra. Datas em ISO. */
export interface KitView {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * A arte propria do card. `null` = o icone do PRIMEIRO item, que e
   * o palpite de sempre. Ver game/card-icons.ts.
   */
  readonly iconFile: string | null;
  /** A aba em que ele aparece no jogo. `null` = sem categoria. */
  readonly category: string | null;
  readonly kind: KitRecord['kind'];
  readonly cooldownSeconds: number | null;
  /** Quantas vezes cada jogador pode levar. `null` em `cooldown`. */
  readonly useLimit: number | null;
  /** Quando a conta de usos zera. */
  readonly useResetOn: KitRecord['useResetOn'];
  /** Só libera este tanto de segundos depois do wipe. */
  readonly wipeDelaySeconds: number | null;
  readonly requiredTier: string | null;
  /** `true` = SÓ aquele nível; um mais alto não serve. */
  readonly requiredTierExact: boolean;
  readonly items: readonly LoadoutItem[];
  readonly enabled: boolean;
  readonly servers: readonly string[];
  readonly claimCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** O mesmo kit, do ponto de vista de UM jogador. */
export interface KitOfferView extends KitView {
  /** Ele pode pegar agora? */
  readonly available: boolean;
  /** Por que não. `null` quando pode. */
  readonly reason: string | null;
  /** Quando ele poderá de novo, num kit de cooldown. ISO. */
  readonly nextAt: string | null;
  /**
   * A última vez que ELE levou este kit. ISO; `null` = nunca.
   *
   * ####  É A PERGUNTA QUE O JOGADOR FAZ  ####
   *
   * "Já peguei este?" e "quando peguei?" não têm resposta na tela
   * sem isto — e sem resposta ele clica para descobrir, o que num
   * kit de resgate único é justamente o clique que não dá para
   * desfazer.
   */
  readonly lastClaimedAt: string | null;
  /**
   * Quantas vezes ELE já levou.
   *
   * Diferente de `claimCount`, que é o total da rede: aquele número
   * é do admin, este é do jogador.
   *
   * É o total HISTÓRICO, e continua sendo depois de um reset de
   * wipe: "você já pegou 12 vezes" é um fato, e apagá-lo da tela
   * porque a conta zerou seria mentir sobre o que aconteceu. Quantos
   * usos sobraram é a outra pergunta, e ela tem campo próprio.
   */
  readonly myClaims: number;
  /**
   * Quantos usos ainda restam a ELE. `null` = não se conta usos
   * neste kit (é o de cooldown).
   *
   * Já com o reset aplicado: num kit que zera no wipe, é o que
   * sobrou DESTE wipe.
   */
  readonly usesLeft: number | null;
}

export interface ClaimResult {
  readonly kit: KitView;
  readonly steamId: string;
  readonly serverId: string;
  readonly claimId: number;
  readonly status: 'entregue' | 'falhou';
  /** Quantos itens do kit chegaram ao jogador. */
  readonly delivered: number;
  readonly total: number;
  readonly detail: string | null;
}

export class KitStore {
  readonly #deps: KitStoreDeps;

  constructor(deps: KitStoreDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  list(): readonly KitView[] {
    return this.#deps.repository.list().map(toKitView);
  }

  get(id: number): KitView | null {
    const kit = this.#deps.repository.get(id);

    return kit === null ? null : toKitView(kit);
  }

  /**
   * Os kits daquele servidor, já com o "pode pegar?" resolvido para
   * um jogador — quando alguém pergunta por um.
   *
   * Sem `steamId`, é só a vitrine: o que aquele servidor oferece.
   */
  async listForServer(serverId: string, steamId?: string): Promise<readonly KitOfferView[]> {
    const kits = this.#deps.repository.listForServer(serverId);

    if (steamId === undefined) {
      return kits.map((kit) => ({
        ...toKitView(kit),
        available: kit.enabled,
        reason: kit.enabled ? null : 'Este kit está fora do ar.',
        nextAt: null,
        lastClaimedAt: null,
        myClaims: 0,
        usesLeft: kit.useLimit,
      }));
    }

    const [levels, wipe] = await Promise.all([this.#levelsOf(serverId), this.#wipeOf(serverId)]);

    const now = Date.now();

    return kits.map((kit) => {
      const problem = this.#whyNot(kit, steamId, levels, now, wipe);
      const last = this.#deps.repository.lastDeliveredClaim(steamId, kit.id);

      return {
        ...toKitView(kit),
        available: problem === null,
        reason: problem?.reason ?? null,
        nextAt: problem?.nextAt ?? null,
        lastClaimedAt: last === null ? null : new Date(last.claimedAt).toISOString(),
        myClaims: this.#deps.repository.deliveredCountOf(steamId, kit.id),
        usesLeft: this.#usesLeft(kit, steamId, wipe),
      };
    });
  }

  claimsOf(
    kitId: number,
    options: { readonly limit: number; readonly offset: number },
  ): {
    readonly claims: readonly {
      readonly id: number;
      readonly steamId: string;
      readonly playerName: string | null;
      readonly serverId: string;
      readonly claimedAt: string;
      readonly status: 'entregue' | 'falhou';
      readonly detail: string | null;
    }[];
    readonly total: number;
  } {
    const page = this.#deps.repository.claimsOf(kitId, options);

    return {
      claims: page.claims.map((claim) => ({
        id: claim.id,
        steamId: claim.steamId,
        playerName: claim.playerName,
        serverId: claim.serverId,
        claimedAt: new Date(claim.claimedAt).toISOString(),
        status: claim.status,
        detail: claim.detail,
      })),
      total: page.total,
    };
  }

  // ------------------------------------------------------
  //  A entrega
  // ------------------------------------------------------

  /**
   * Entrega o kit AGORA.
   *
   * A ordem é: conferir tudo, abrir a linha, mandar os comandos,
   * fechar a linha. Ver o cabeçalho para o porquê de cada passo.
   *
   * @throws {ApiError} 404 kit desconhecido, 409 quando a regra do
   * kit recusa (já pegou, cooldown, nível, servidor), 422 com o
   * jogador offline, 503 sem RCON ou sem lista de presença.
   */
  async claim(input: {
    readonly kitId: number;
    readonly steamId: string;
    readonly serverId: string;
    readonly actor: string | null;
  }): Promise<ClaimResult> {
    assertSteamId(input.steamId);

    const kit = this.#deps.repository.get(input.kitId);

    if (kit === null) {
      throw new ApiError('KIT_NOT_FOUND', `Não existe kit com o id ${String(input.kitId)}.`, 404);
    }

    if (!kit.servers.includes(input.serverId)) {
      throw new ApiError(
        'KIT_NOT_OFFERED_HERE',
        `O kit "${kit.name}" não é oferecido em "${input.serverId}". Os servidores dele: ` +
          `${kit.servers.join(', ') || '(nenhum)'}.`,
        409,
      );
    }

    const [levels, wipe] = await Promise.all([
      this.#levelsOf(input.serverId),
      this.#wipeOf(input.serverId),
    ]);

    // A MESMA função da vitrine: uma tela que oferece o botão e uma
    // rota que recusa é o pior desencontro possível.
    const problem = this.#whyNot(kit, input.steamId, levels, Date.now(), wipe);

    if (problem !== null) {
      throw new ApiError(problem.code, problem.reason, 409);
    }

    const rcon =
      this.#deps.servers.contextOf(input.serverId)?.rcon ?? disconnectedRcon(input.serverId);

    if (!rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON de "${input.serverId}". A entrega acontece dentro do jogo, e o ` +
          'agente precisa falar com o servidor para pôr o item no inventário.',
        503,
      );
    }

    const online = await this.#deps.presence.online(input.serverId);

    if (online === null) {
      throw new ApiError(
        'PRESENCE_UNAVAILABLE',
        `Não consegui conferir quem está em "${input.serverId}" agora. A entrega NÃO foi feita — ` +
          'entregar sem saber se o jogador está lá é como jogar o item fora.',
        503,
      );
    }

    if (!online.includes(input.steamId)) {
      throw new ApiError(
        'PLAYER_OFFLINE',
        `${input.steamId} não está em "${input.serverId}" agora. O item entra no INVENTÁRIO, e ` +
          'inventário só existe para quem está conectado — entre no servidor e resgate de novo.',
        422,
      );
    }

    // ---- daqui para baixo, a tentativa fica registrada ----
    const claimId = this.#deps.repository.openClaim({
      kitId: kit.id,
      steamId: input.steamId,
      serverId: input.serverId,
    });

    const delivery = await this.#deliver(rcon, input.steamId, kit.items);
    const status = delivery.delivered > 0 ? 'entregue' : 'falhou';

    this.#deps.repository.closeClaim(claimId, status, delivery.detail);

    this.#deps.logger.info(
      {
        server: input.serverId,
        steamId: input.steamId,
        kit: kit.slug,
        status,
        delivered: delivery.delivered,
        total: kit.items.length,
        by: input.actor,
      },
      'kit entregue',
    );

    this.#record(input, kit, status, delivery.detail);

    return {
      kit: toKitView(kit),
      steamId: input.steamId,
      serverId: input.serverId,
      claimId,
      status,
      delivered: delivery.delivered,
      total: kit.items.length,
      detail: delivery.detail,
    };
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /**
   * Por que este jogador NÃO pode pegar este kit agora.
   *
   * `null` = ele pode. As quatro recusas moram aqui, num lugar só,
   * porque a vitrine e a entrega precisam responder EXATAMENTE a
   * mesma coisa — uma tela que oferece o botão e uma rota que recusa
   * é o pior desencontro possível.
   *
   * Estar online NÃO é conferido aqui: isso custa uma ida ao RCON, e
   * a vitrine lista dezenas de kits. Ele é conferido uma vez, na
   * entrega.
   */
  #whyNot(
    kit: KitRecord,
    steamId: string,
    levels: readonly VipTierLevel[],
    now: number,
    /** As horas de wipe. `null` em cada uma = não deu para saber. */
    wipe: WipeMoment = { at: null, fullAt: null },
  ): { readonly code: string; readonly reason: string; readonly nextAt: string | null } | null {
    if (!kit.enabled) {
      return { code: 'KIT_DISABLED', reason: `O kit "${kit.name}" está fora do ar.`, nextAt: null };
    }

    // ####  O KIT QUE SÓ LIBERA DEPOIS DO WIPE  ####
    //
    // Um kit avançado entregue na primeira hora apaga a corrida
    // inicial, que é a parte do jogo que traz gente de volta.
    //
    // Sem saber a hora do wipe (`null`), o kit LIBERA. Recusar sem
    // certeza puniria o jogador por um servidor que não respondeu —
    // o mesmo critério do veículo sem espaço, na loja.
    if (kit.wipeDelaySeconds !== null && wipe.at !== null) {
      const free = wipe.at + kit.wipeDelaySeconds * 1000;

      if (free > now) {
        return {
          code: 'KIT_AFTER_WIPE',
          reason:
            `O kit "${kit.name}" só libera ${describeWait(kit.wipeDelaySeconds * 1000)} depois do ` +
            `wipe. Faltam ${describeWait(free - now)} (${new Date(free).toLocaleString('pt-BR')}).`,
          nextAt: new Date(free).toISOString(),
        };
      }
    }

    if (
      kit.requiredTier !== null &&
      !this.#hasTier(steamId, kit.requiredTier, kit.requiredTierExact, levels, now)
    ) {
      return {
        code: 'KIT_TIER_REQUIRED',
        reason: kit.requiredTierExact
          ? `O kit "${kit.name}" é exclusivo do VIP ${kit.requiredTier}, e ${steamId} não tem ` +
            'esse nível ativo. Um nível mais alto NÃO serve — este kit é só daquele.'
          : `O kit "${kit.name}" é do VIP ${kit.requiredTier} (ou superior), e ${steamId} não tem ` +
            'esse nível ativo.',
        nextAt: null,
      };
    }

    const last = this.#deps.repository.lastDeliveredClaim(steamId, kit.id);

    // ####  OS USOS ACABARAM  ####
    //
    // "Resgate único" é este mesmo teste com o limite valendo 1 —
    // não são duas regras, é uma só com dois números. A janela da
    // contagem é o que o reset move: ver `#usedIn`.
    if (kit.kind === 'resgate') {
      const limit = kit.useLimit ?? 1;
      const used = this.#usedIn(kit, steamId, wipe);

      if (used >= limit) {
        return {
          code: limit === 1 ? 'KIT_ALREADY_CLAIMED' : 'KIT_USES_SPENT',
          reason:
            limit === 1
              ? `O kit "${kit.name}" é de resgate único, e ${steamId} já o pegou` +
                (last === null
                  ? '.'
                  : ` em ${new Date(last.claimedAt).toLocaleDateString('pt-BR')}.`) +
                resetNote(kit.useResetOn)
              : `O kit "${kit.name}" dá ${String(limit)} ${limit === 1 ? 'uso' : 'usos'} por ` +
                `jogador, e ${steamId} já gastou ${String(used)}.` +
                resetNote(kit.useResetOn),
          nextAt: null,
        };
      }
    }

    if (kit.kind === 'cooldown' && last !== null) {
      const next = last.claimedAt + (kit.cooldownSeconds ?? 0) * 1000;

      if (next > now) {
        return {
          code: 'KIT_ON_COOLDOWN',
          reason:
            `O kit "${kit.name}" volta a ficar disponível para ${steamId} em ` +
            `${describeWait(next - now)} (${new Date(next).toLocaleString('pt-BR')}).`,
          nextAt: new Date(next).toISOString(),
        };
      }
    }

    return null;
  }

  /**
   * O jogador tem aquele nível — ou um MAIS ALTO?
   *
   * A ordem sai do `Rank` do `OrigemZVip.json` daquele servidor, que
   * é a mesma tabela que o plugin usa no `HasVipTier`. Sem os níveis
   * (config ausente), a comparação vira igualdade pura: é o que se
   * pode afirmar sem inventar hierarquia.
   *
   * ####  E COM `exact`, "MAIS ALTO" NÃO VALE  ####
   *
   * O kit exclusivo de um nível é a recompensa DAQUELE nível: se o
   * Diamante também o pegasse, o Ouro deixaria de ter algo que só
   * ele tem — e o mesmo vale ao contrário, com o Ouro limpando os
   * kits do Bronze. Ter o tier exato entre os VIPs ativos basta:
   * quem tem dois níveis ativos pega os kits dos dois.
   */
  #hasTier(
    steamId: string,
    required: string,
    exact: boolean,
    levels: readonly VipTierLevel[],
    now: number,
  ): boolean {
    const tiers = this.#deps.vips.activeOf(steamId, now).map((vip) => vip.tier);
    const wanted = required.trim().toLowerCase();

    if (tiers.includes(wanted)) {
      return true;
    }

    if (exact) {
      return false;
    }

    const rankOf = new Map(levels.map((level, index) => [level.tier, level.rank ?? index]));
    const needed = rankOf.get(wanted);

    if (needed === undefined) {
      return false;
    }

    return tiers.some((tier) => (rankOf.get(tier) ?? Number.NEGATIVE_INFINITY) >= needed);
  }

  /**
   * Manda os itens, um comando por item.
   *
   * ####  O SLOT NÃO ATRAVESSA A ENTREGA, E ISSO É DO PLUGIN  ####
   *
   * O `origemz.give` recebe `<steamId> <shortname> <amount>
   * <skinId> <mode>` e nada mais: quem entende de slot e posição é o
   * `OrigemZPlayer`, e só no caminho do NASCIMENTO (o hook
   * `GetLoadout`). Então um kit da loja chega ao inventário, e não
   * montado na barra rápida como o loadout de quem renasce.
   *
   * O editor guarda `slot` e `position` do mesmo jeito — é o mesmo
   * componente do loadout, e o dado continua certo para o dia em que
   * o plugin ganhar um comando que os aceite.
   *
   * ####  UM ITEM QUE FALHA NÃO INTERROMPE OS OUTROS  ####
   *
   * Metade do kit é melhor que nada, e o que faltou vai no detalhe
   * do claim — com nome e motivo, para quem administra completar à
   * mão.
   */
  async #deliver(
    rcon: OpsRcon,
    steamId: string,
    items: readonly LoadoutItem[],
  ): Promise<{ readonly delivered: number; readonly detail: string | null }> {
    if (items.length === 0) {
      return { delivered: 0, detail: 'O kit está vazio: não havia item nenhum para entregar.' };
    }

    const failures: string[] = [];
    let delivered = 0;

    for (const item of items) {
      const command =
        `${GIVE_COMMAND} ${steamId} ${item.shortname} ${String(item.amount)} ` +
        `${item.skinId} ${GIVE_MODE}`;

      try {
        const response = firstJsonLine(await rcon.send(command));

        if (response !== null && (response as { ok?: unknown }).ok === true) {
          delivered += 1;
          continue;
        }

        const code = (response as { error?: unknown } | null)?.error;

        failures.push(
          `${item.shortname}: ${typeof code === 'string' ? describeGiveError(code) : 'resposta ilegível'}`,
        );
      } catch (error) {
        failures.push(`${item.shortname}: ${toError(error).message}`);
      }
    }

    if (failures.length === 0) {
      return { delivered, detail: null };
    }

    return {
      delivered,
      detail:
        `${String(delivered)} de ${String(items.length)} itens entregues. ` +
        `Faltou: ${failures.join('; ')}.`,
    };
  }

  /** Quando foi o wipe. `null` = sem relógio, ou sem resposta. */
  async #wipeOf(serverId: string): Promise<WipeMoment> {
    const clock = this.#deps.wipe;

    if (clock === undefined) {
      return { at: null, fullAt: null };
    }

    const [at, fullAt] = await Promise.all([
      clock.at(serverId),
      clock.fullAt?.(serverId) ?? Promise.resolve(null),
    ]);

    return { at, fullAt };
  }

  /**
   * Quantos usos ele já gastou DENTRO da janela do reset.
   *
   * ####  A JANELA É A DO SERVIDOR ONDE ELE ESTÁ PEGANDO  ####
   *
   * O kit é da rede e o claim é de um servidor: um kit que reseta no
   * wipe, oferecido em dois servidores, usa a hora do wipe DAQUELE
   * em que o jogador está agora. É o que ele espera ver — quem
   * acabou de pegar um mapa novo espera o kit de novo.
   *
   * Sem a hora (servidor mudo, nenhum full wipe registrado), a
   * janela é "desde sempre": ver a migração 054.
   */
  #usedIn(kit: KitRecord, steamId: string, wipe: WipeMoment): number {
    const since =
      kit.useResetOn === 'wipe'
        ? (wipe.at ?? 0)
        : kit.useResetOn === 'full-wipe'
          ? (wipe.fullAt ?? 0)
          : 0;

    return since === 0
      ? this.#deps.repository.deliveredCountOf(steamId, kit.id)
      : this.#deps.repository.deliveredCountSince(steamId, kit.id, since);
  }

  /** Quantos usos sobraram. `null` no kit que não conta usos. */
  #usesLeft(kit: KitRecord, steamId: string, wipe: WipeMoment): number | null {
    if (kit.kind !== 'resgate') {
      return null;
    }

    return Math.max(0, (kit.useLimit ?? 1) - this.#usedIn(kit, steamId, wipe));
  }

  async #levelsOf(serverId: string): Promise<readonly VipTierLevel[]> {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      return [];
    }

    return (await readVipTiers(config.paths.oxideConfigDir)).levels;
  }

  /** A linha do tempo da ficha do jogador. Nunca derruba a entrega. */
  #record(
    input: { readonly steamId: string; readonly serverId: string; readonly actor: string | null },
    kit: KitRecord,
    status: 'entregue' | 'falhou',
    detail: string | null,
  ): void {
    if (this.#deps.history === undefined) {
      return;
    }

    try {
      this.#deps.history.recordAction({
        steamId: input.steamId,
        serverId: input.serverId,
        kind: 'kit',
        actor: input.actor,
        detail:
          (status === 'entregue' ? `recebeu o kit "${kit.name}"` : `não recebeu o kit "${kit.name}"`) +
          (detail === null ? '' : ` — ${detail}`),
      });
    } catch (error) {
      this.#deps.logger.debug(
        { steamId: input.steamId, err: toError(error) },
        'não consegui registrar o kit na ficha do jogador',
      );
    }
  }
}

/**
 * O que ainda pode devolver o uso, na frase da recusa.
 *
 * "Você já gastou os 10" sem dizer que o wipe devolve manda o
 * jogador ao suporte perguntar exatamente isso.
 */
function resetNote(reset: KitRecord['useResetOn']): string {
  if (reset === 'wipe') {
    return ' A conta zera no próximo wipe.';
  }

  return reset === 'full-wipe' ? ' A conta zera no próximo full wipe.' : '';
}

/** "2 h 15 min", "45 min", "30 s" — para a frase da recusa. */
function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) {
    return `${String(seconds)} s`;
  }

  const minutes = Math.ceil(seconds / 60);

  if (minutes < 60) {
    return `${String(minutes)} min`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

function toKitView(kit: KitRecord): KitView {
  return {
    id: kit.id,
    slug: kit.slug,
    name: kit.name,
    description: kit.description,
    iconFile: kit.iconFile,
    category: kit.category,
    kind: kit.kind,
    cooldownSeconds: kit.cooldownSeconds,
    useLimit: kit.useLimit,
    useResetOn: kit.useResetOn,
    wipeDelaySeconds: kit.wipeDelaySeconds,
    requiredTier: kit.requiredTier,
    requiredTierExact: kit.requiredTierExact,
    items: kit.items,
    enabled: kit.enabled,
    servers: kit.servers,
    claimCount: kit.claimCount,
    createdAt: new Date(kit.createdAt).toISOString(),
    updatedAt: new Date(kit.updatedAt).toISOString(),
  };
}
