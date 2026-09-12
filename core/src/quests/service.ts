// ============================================================
//  service.ts  -  a REGRA das quests.
//
//  Tudo o que decide alguma coisa mora aqui: quem pode ver o quê,
//  quando uma quest volta a estar disponível, se os objetivos
//  fecharam, e o que acontece no resgate. O repositório guarda; a
//  rota traduz; este arquivo decide.
//
//  ------------------------------------------------------------
//  ####  A AUTORIDADE É DAQUI, E NÃO DO PLUGIN  ####
//
//  O plugin conta para a TELA — ele precisa mostrar o progresso no
//  instante em que o jogador mina a pedra. O agente conta para o
//  PRÊMIO.
//
//  Por isso `reportCompletion` não acredita no plugin: ele recebe
//  "esta tentativa fechou", CONFERE com o número daqui e só então
//  marca. Um `oxide.reload` no meio do lote esvazia o cache do
//  plugin sem derrubar o RCON — para o agente, nada aconteceu — e
//  sem essa conferência a conclusão sairia de um contador
//  incompleto.
//
//  ------------------------------------------------------------
//  ####  DOIS OBJETIVOS NÃO PASSAM PELO PLUGIN  ####
//
//  `metric` e `playtime` são lidos de `player_stats`, que é um
//  TOTAL acumulado e não sabe que a quest existe. O progresso deles
//  é uma SUBTRAÇÃO — quanto subiu desde o aceite —, e a linha de
//  partida está no `snapshot.baselines`.
//
//  Sem ela, quem já tinha 4.000 abates concluiria "mate 20" no
//  instante em que aceitasse.
//
//  ------------------------------------------------------------
//  ####  A HORA DA VIRADA É A DO PROCESSO  ####
//
//  `daily` e `weekly` viram no fuso de quem roda o agente, com
//  `resetAtMinute` minutos depois da meia-noite local. É mais
//  simples do que o desenho das mensagens agendadas (que carrega a
//  zona IANA por mensagem, ver types/messages.ts) e é o bastante:
//  uma rede de servidores tem UM dono, num fuso só.
//
//  Se um dia a rede for de dois países, o caminho já está escrito
//  lá — e é uma coluna em `quest_settings`, não um redesenho.
//
//  ------------------------------------------------------------
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §5, §6 e §7.
// ============================================================

import type {
  PlayerQuestRecord,
  QuestRecord,
  QuestsRepository,
} from '../db/quests-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import {
  type QuestObjective,
  type QuestReward,
  type QuestSnapshot,
  type QuestSettings,
} from '../types/quests.js';
import type { QuestRewardService, RewardOutcome } from './rewards.js';

// ------------------------------------------------------------
//  §1  O QUE ELE PRECISA DOS OUTROS
// ------------------------------------------------------------

/**
 * De onde vem o número dos objetivos `metric` e `playtime`.
 *
 * Interface mínima de propósito: em produção quem a satisfaz lê
 * `player_stats` pelo período `lifetime` — o único que NUNCA zera.
 *
 * ####  POR QUE `lifetime`, E NÃO O PERÍODO DA DISPUTA  ####
 *
 * Porque um wipe no meio de uma quest faria o total CAIR, e a
 * subtração `agora - partida` viraria negativa. O jogador veria o
 * progresso andar para trás por algo que não fez.
 */
export interface QuestStatsSource {
  /** O total acumulado. `0` quando aquilo nunca foi medido. */
  totalOf(serverId: string, steamId: string, metric: string): number;
}

/**
 * Quem responde ao campo `requires` da quest.
 *
 * O valor é opaco para o serviço — `'origemzquests.vip'`,
 * `'vip:ouro'` —, e é de propósito: quem sabe o que cada forma
 * significa é quem conhece o Oxide e a lista de VIP.
 *
 * Ausente = nenhuma quest com `requires` fica disponível. Recusar é
 * o único desfecho seguro: liberar o que não se sabe conferir
 * entrega a quest de VIP para todo mundo.
 */
export interface QuestPermissions {
  can(input: {
    readonly steamId: string;
    readonly serverId: string;
    readonly requires: string;
  }): Promise<boolean> | boolean;
}

/** O nome bonito do catálogo do jogo, para a frase do objetivo. */
export interface QuestItemNames {
  displayNameOf(shortname: string): string | null;
}

/**
 * Quem tira os itens do inventário no resgate.
 *
 * ####  É O `ItemDeduction` DO Quests.cs  ####
 *
 * Uma missão de "junte 500 de scrap" pode ser um PEDIDO: o jogador
 * entrega o scrap e recebe outra coisa. Sem isto, o campo `consume`
 * existiria no painel sem fazer nada — e o admin cadastraria a
 * missão achando que o material sai.
 *
 * Ausente = o resgate de uma missão com `consume` FALHA com uma
 * frase que diz isso. Entregar o prêmio sem cobrar o material é
 * pior: o jogador fica com os dois, e ninguém percebe.
 */
export interface QuestConsumer {
  /**
   * Tira os itens. `taken` é o que saiu de verdade.
   *
   * `complete: false` = faltou item, e NADA foi tirado — a
   * operação é tudo ou nada, senão um resgate que falha no meio
   * cobra metade e não entrega nada.
   */
  take(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly items: readonly { readonly shortname: string; readonly amount: number }[];
  }): Promise<{ readonly complete: boolean; readonly missing?: string }>;
}

export interface QuestsServiceDeps {
  readonly repository: QuestsRepository;
  readonly logger: Logger;
  readonly rewards?: QuestRewardService;
  readonly stats?: QuestStatsSource;
  readonly permissions?: QuestPermissions;
  readonly items?: QuestItemNames;
  readonly consumer?: QuestConsumer;
  /**
   * Avisado quando as tentativas VIVAS de um jogador mudam.
   *
   * ####  SEM ISTO, O PLUGIN DEMORA UM CICLO  ####
   *
   * O `assign` só sai quando o coletor nota a diferença — e ele
   * roda a cada 15 s. Quinze segundos em que o jogador aceitou a
   * missão, foi minerar, e nada contou.
   *
   * Não é o serviço que manda o comando: ele AVISA, e quem fala com
   * o jogo decide quando. Chamar RCON daqui poria uma ida à rede no
   * meio de uma transação.
   */
  readonly onLiveChanged?: (input: {
    readonly serverId: string;
    readonly steamId: string;
  }) => void;
  readonly now?: () => number;
}

function npcTalkKey(input: {
  readonly serverId: string;
  readonly steamId: string;
  readonly npcId: string;
}): string {
  return `${input.serverId}:${input.steamId}:${input.npcId}`;
}

// ------------------------------------------------------------
//  §2  O VOCABULÁRIO DA TELA
// ------------------------------------------------------------

/** Por que uma quest não pode ser aceita agora. */
export interface QuestBlock {
  readonly code: string;
  /** Português, pronto para a tela do jogo. */
  readonly reason: string;
}

export interface QuestOffer {
  readonly quest: QuestRecord;
  /** `null` = pode aceitar. */
  readonly block: QuestBlock | null;
  /** Quando ela volta, se estiver em cooldown. */
  readonly availableAt: number | null;
}

export interface ObjectiveView {
  readonly seq: number;
  readonly label: string;
  readonly have: number;
  readonly need: number;
  readonly done: boolean;
}

export interface QuestProgressView {
  readonly playerQuestId: number;
  readonly questId: string;
  readonly title: string;
  readonly status: PlayerQuestRecord['status'];
  readonly objectives: readonly ObjectiveView[];
  readonly rewards: readonly QuestReward[];
  /** Todos os objetivos fecharam? */
  readonly complete: boolean;
  readonly acceptedAt: number;
  readonly completedAt: number | null;
}

export interface ClaimResult {
  readonly playerQuestId: number;
  readonly questId: string;
  readonly outcomes: readonly RewardOutcome[];
  /** Alguma recompensa ficou para trás? É o que o painel lista. */
  readonly pending: boolean;
}

// ------------------------------------------------------------
//  §3  O SERVIÇO
// ------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Por quanto tempo uma conversa com o NPC continua valendo.
 *
 * O jogador aperta TALK, a tela abre, ele lê a descrição, pensa. Um
 * minuto seria curto para quem lê devagar; uma hora faria a
 * conversa valer de dentro de casa, longe do boneco — que é
 * justamente o que a regra existe para impedir.
 */
const NPC_TALK_TTL_MS = 5 * MINUTE_MS;

export class QuestsService {
  readonly #deps: QuestsServiceDeps;

  /**
   * Quem falou com qual NPC, e quando.
   *
   * ####  É ISTO QUE DÁ AUTORIDADE AO "FALE COM O MATEUS"  ####
   *
   * A quest de NPC aparece no menu (ver `offersFor`), e o botão de
   * aceitar dela precisa de uma pergunta que o AGENTE saiba
   * responder: este jogador esteve no balcão?
   *
   * A resposta não pode vir do clique — o alvo do botão é texto que
   * chega do jogo, e um cliente adulterado mandaria o que quisesse.
   * Ela vem do empurrão do plugin: o USE/TALK no NPC é medido lá,
   * com distância, e chega aqui pelo `noteNpcTalk`.
   *
   * Memória, e não coluna: a conversa vale minutos, e um agente que
   * reinicia deve mesmo pedir que o jogador fale de novo.
   */
  readonly #npcTalks = new Map<string, number>();

  constructor(deps: QuestsServiceDeps) {
    this.#deps = deps;
  }

  /**
   * O jogador acabou de falar com aquele NPC.
   *
   * Chamado pelo `QuestNpcSync` quando o plugin grita o USE. A
   * limpeza é oportunista: a cada anotação, o que venceu sai. Sem
   * ela o mapa cresceria com um par por jogador e por NPC até o
   * próximo boot.
   */
  noteNpcTalk(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId: string;
  }): void {
    const now = this.#now();

    for (const [key, at] of this.#npcTalks) {
      if (now - at > NPC_TALK_TTL_MS) {
        this.#npcTalks.delete(key);
      }
    }

    this.#npcTalks.set(npcTalkKey(input), now);
  }

  /** Ele esteve no balcão nos últimos minutos? */
  #talkedRecently(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId: string;
  }): boolean {
    const at = this.#npcTalks.get(npcTalkKey(input));

    return at !== undefined && this.#now() - at <= NPC_TALK_TTL_MS;
  }

  // ======================================================
  //  LEITURA
  // ======================================================

  /**
   * O que este jogador pode pegar agora, neste servidor.
   *
   * ####  A LISTA VEM COM OS BLOQUEADOS DENTRO  ####
   *
   * E não filtrada. A tela do jogo precisa mostrar "volta em 4h" e
   * "conclua Boas-vindas primeiro" — uma quest que simplesmente
   * SOME é uma quest sobre a qual ninguém consegue perguntar.
   *
   * Quem esconde é a tela, e só o que não faz sentido mostrar: a
   * desligada e a de outro servidor nem chegam aqui.
   *
   * `npcId` recorta: `undefined` traz as de menu (as sem NPC),
   * um id traz as DAQUELE NPC. São duas telas diferentes, e
   * misturá-las poria no menu a quest que só se pega no mapa.
   */
  async offersFor(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId?: string;
  }): Promise<readonly QuestOffer[]> {
    const settings = this.#deps.repository.settingsOf(input.serverId);

    if (!settings.enabled) {
      return [];
    }

    // ####  UM NPC DE ENTREGA NÃO OFERECE MISSÃO  ####
    //
    // É o que a coluna `kind` decide, e a diferença é real: o NPC de
    // destino de uma entrega existe para RECEBER o pacote. Abrir uma
    // lista de missões nele confundiria — o jogador chegaria lá com
    // o pacote e veria uma vitrine.
    //
    // A tela dele fica vazia com a frase de "este NPC não tem
    // missões", que é a verdade.
    if (input.npcId !== undefined) {
      const npc = this.#deps.repository.getNpc(input.npcId);

      if (npc === null || npc.kind === 'delivery') {
        return [];
      }
    }

    const now = this.#now();
    const live = this.#deps.repository.liveFor(input.serverId, input.steamId);
    const liveIds = new Set(live.map((item) => item.questId));

    const offers: QuestOffer[] = [];

    for (const quest of this.#deps.repository.listForServer(input.serverId)) {
      // ####  A QUEST ÓRFÃ VOLTA AO MENU  ####
      //
      // Apagar um NPC não apaga a quest dele — de propósito, para
      // não levar junto o progresso de quem estava fazendo. Mas sem
      // esta linha ela sumiria de TODO lugar: do menu, por ter
      // `npcId`; e do NPC, que não existe mais.
      //
      // Ficar invisível para sempre é pior que voltar ao menu, e é o
      // que o painel promete quando avisa quais quests ficaram
      // órfãs.
      const npcId =
        quest.npcId === null || this.#deps.repository.getNpc(quest.npcId) === null
          ? undefined
          : quest.npcId;

      // ####  A TELA DO NPC MOSTRA SÓ AS DELE; O MENU MOSTRA TUDO  ####
      //
      // Decisão do dono em 11/09/2026, depois do teste que abriu o
      // menu e leu "Disponíveis: 0" com uma missão cadastrada e
      // ligada. Ela estava lá — escondida atrás de um boneco que o
      // jogador não sabia que existia.
      //
      // Aparecer não é poder pegar: quem tem NPC continua só se
      // aceitando NELE, e o bloqueio de `#whyNot` diz com quem
      // falar. O menu vira o cartaz; o NPC continua sendo o balcão.
      if (input.npcId !== undefined && npcId !== input.npcId) {
        continue;
      }

      // Já está fazendo: ela aparece na aba das ativas, não na das
      // disponíveis. Mostrá-la nas duas daria dois botões para a
      // mesma coisa, e um deles recusaria.
      if (liveIds.has(quest.id)) {
        continue;
      }

      const last = this.#deps.repository.lastAttempt(input.serverId, input.steamId, quest.id);

      offers.push({
        quest,
        block: await this.#whyNot({ quest, last, live, settings, now, ...input }),
        availableAt: last?.cooldownUntil ?? null,
      });
    }

    return offers;
  }

  /**
   * As quests vivas dele, com o progresso já atualizado.
   *
   * ####  ELA RECALCULA ANTES DE RESPONDER  ####
   *
   * Os objetivos `metric` e `playtime` não têm quem os empurre: o
   * lote do plugin não os traz. Se a leitura não os recalculasse,
   * "fique 60 minutos online" ficaria em zero até alguém abrir o
   * painel — e nunca concluiria.
   *
   * O recálculo é barato (uma consulta por métrica distinta) e
   * acontece no caminho que já ia ler o banco de qualquer jeito.
   */
  liveFor(input: {
    readonly serverId: string;
    readonly steamId: string;
  }): readonly QuestProgressView[] {
    this.refreshDerived(input);

    return this.#deps.repository
      .liveFor(input.serverId, input.steamId)
      .map((attempt) => this.viewOf(attempt));
  }

  /**
   * Uma tentativa pelo id, já em forma de tela.
   *
   * `null` quando ela não existe (mais). Existe para quem tem o id
   * e não o registro — o push do plugin traz só o número, e montar
   * um `PlayerQuestRecord` de mentira para chamar o `viewOf` daria
   * um título vazio no recibo.
   */
  viewById(playerQuestId: number): QuestProgressView | null {
    const attempt = this.#deps.repository.attempt(playerQuestId);

    return attempt === null ? null : this.viewOf(attempt);
  }

  /** Uma tentativa, para a tela de detalhe e para o resgate. */
  viewOf(attempt: PlayerQuestRecord): QuestProgressView {
    const objectives = attempt.snapshot.objectives.map((objective) =>
      this.#objectiveView(objective, attempt.progress[objective.seq] ?? 0),
    );

    return {
      playerQuestId: attempt.id,
      questId: attempt.questId,
      title: attempt.snapshot.title,
      status: attempt.status,
      objectives,
      rewards: attempt.snapshot.rewards,
      complete: objectives.every((item) => item.done),
      acceptedAt: attempt.acceptedAt,
      completedAt: attempt.completedAt,
    };
  }

  /**
   * A frase que o jogador lê.
   *
   * Montada aqui, e não gravada: o nome bonito do item vem do
   * catálogo do JOGO, que muda a cada update do Rust. Gravar a
   * frase no cadastro deixaria "Sulfur Ore" numa tela em português
   * para sempre.
   *
   * O `label` do objetivo sobrescreve tudo — é a escotilha para
   * quando o texto montado não serve.
   */
  describeObjective(objective: QuestObjective): string {
    if (objective.label !== null && objective.label !== '') {
      return objective.label;
    }

    const amount = objective.amount.toLocaleString('pt-BR');

    switch (objective.kind) {
      case 'kill':
        return `Matar ${amount} ${this.#nameOf(objective.target)}`;
      case 'gather':
        return `Coletar ${amount} de ${this.#nameOf(objective.target)}`;
      case 'craft':
        return `Fabricar ${amount} ${this.#nameOf(objective.target)}`;
      case 'loot':
        return `Saquear ${amount} de ${this.#nameOf(objective.target)}`;
      case 'deliver':
        return `Entregar o pacote para ${this.#nameOf(objective.target)}`;
      case 'playtime':
        return `Ficar ${amount} minuto(s) online`;
      case 'metric':
        return `Chegar a ${amount} em ${objective.metric ?? '?'}`;
    }
  }

  // ======================================================
  //  ESCRITA
  // ======================================================

  /**
   * O jogador aceita.
   *
   * ####  A CONFERÊNCIA ACONTECE AQUI, E SÓ AQUI  ####
   *
   * O `#whyNot` é o MESMO que monta a lista da tela. Uma tela que
   * oferece o botão e uma rota que recusa é o pior desencontro
   * possível — é a lição que o `KitsService` já documenta.
   *
   * @throws {ApiError} 404 quest desconhecida, 409 com qualquer
   * bloqueio.
   */
  async accept(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly questId: string;
    readonly playerName?: string | null;
    /** Quem mandou. `null` = o próprio jogador, pelo menu. */
    readonly actor?: string | null;
    /**
     * Pula a conferência.
     *
     * É o "conceder quest" do painel: o suporte dá a quest a quem
     * não poderia pegá-la — cooldown, cadeia, teto. A trava de
     * tentativa duplicada continua valendo, porque ela é de
     * integridade e não de regra.
     */
    readonly force?: boolean;
  }): Promise<QuestProgressView> {
    const quest = this.#deps.repository.get(input.questId);

    if (quest === null) {
      throw new ApiError('QUEST_NOT_FOUND', `Não existe a quest "${input.questId}".`, 404);
    }

    if (input.force !== true) {
      const settings = this.#deps.repository.settingsOf(input.serverId);
      const block = await this.#whyNot({
        quest,
        last: this.#deps.repository.lastAttempt(input.serverId, input.steamId, quest.id),
        live: this.#deps.repository.liveFor(input.serverId, input.steamId),
        settings,
        now: this.#now(),
        serverId: input.serverId,
        steamId: input.steamId,
      });

      if (block !== null) {
        throw new ApiError(block.code, block.reason, 409);
      }
    }

    const attempt = this.#deps.repository.accept(
      {
        serverId: input.serverId,
        steamId: input.steamId,
        playerName: input.playerName,
        questId: quest.id,
        snapshot: this.#snapshotOf(quest, input.serverId, input.steamId),
      },
      this.#now(),
    );

    this.#deps.logger.info(
      {
        serverId: input.serverId,
        steamId: input.steamId,
        questId: quest.id,
        attempt: attempt.attempt,
        actor: input.actor ?? null,
      },
      'quest aceita',
    );

    this.#deps.onLiveChanged?.({ serverId: input.serverId, steamId: input.steamId });

    return this.viewOf(attempt);
  }

  /**
   * Abre sozinha o que tem `auto_accept`.
   *
   * ####  É O QUE FAZ A DIÁRIA FUNCIONAR SEM CLIQUE  ####
   *
   * Chamada quando o jogador conecta, e de novo na virada do dia
   * para quem já estava online — senão a diária de hoje só
   * começaria na próxima vez que ele entrasse no servidor.
   *
   * Ela respeita TODAS as regras: uma diária em cooldown, uma quest
   * de cadeia sem a anterior, ou o teto atingido simplesmente não
   * abrem. `auto_accept` diz "não precisa clicar", e não "pode
   * furar a fila".
   *
   * Nunca lança: um bloqueio no meio da lista não pode impedir as
   * outras de abrirem, e isto roda no caminho do `OnPlayerConnected`.
   *
   * @returns as que foram abertas agora.
   */
  async autoAcceptFor(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly playerName?: string | null;
  }): Promise<readonly QuestProgressView[]> {
    const opened: QuestProgressView[] = [];

    // Só as de MENU: uma quest de NPC que se aceitasse sozinha
    // apareceria como ativa sem o jogador nunca ter ido lá — e o
    // NPC deixaria de ter função.
    for (const offer of await this.offersFor(input)) {
      if (!offer.quest.autoAccept || offer.block !== null) {
        continue;
      }

      try {
        opened.push(await this.accept({ ...input, questId: offer.quest.id }));
      } catch (cause) {
        // Perder uma quest automática é chato; derrubar a conexão
        // do jogador por causa dela é pior.
        this.#deps.logger.warn(
          { ...input, questId: offer.quest.id, err: cause },
          'não deu para abrir a quest automática',
        );
      }
    }

    return opened;
  }

  /**
   * O jogador cancela, ou o admin reseta.
   *
   * O evento é escrito AQUI e não no repositório porque a frase
   * muda com o autor — ver o comentário do `abandon` lá.
   */
  cancel(input: {
    readonly playerQuestId: number;
    readonly actor?: string | null;
    readonly reason?: string;
  }): boolean {
    const attempt = this.#deps.repository.attempt(input.playerQuestId);

    if (attempt === null) {
      return false;
    }

    if (!this.#deps.repository.abandon(input.playerQuestId)) {
      return false;
    }

    this.#deps.onLiveChanged?.({ serverId: attempt.serverId, steamId: attempt.steamId });

    this.#deps.repository.recordEvent(
      {
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        questId: attempt.questId,
        attempt: attempt.attempt,
        kind: 'abandon',
        source: input.actor === undefined || input.actor === null ? 'agent' : 'panel',
        actor: input.actor ?? null,
        detail: input.reason === undefined ? undefined : { reason: input.reason },
      },
      this.#now(),
    );

    return true;
  }

  /**
   * Aplica o lote do plugin e conclui o que fechou.
   *
   * A conclusão acontece DEPOIS do lote e no mesmo caminho: o
   * jogador que passou dos 5.000 no último lote precisa ver a
   * quest concluída sem esperar o push, que pode ter se perdido.
   *
   * @returns quantas tentativas concluíram agora.
   */
  applyBatch(input: {
    readonly serverId: string;
    readonly batchId: string;
    readonly entries: readonly {
      readonly playerQuestId: number;
      readonly objectiveSeq: number;
      readonly delta: number;
    }[];
  }): { readonly applied: boolean; readonly completed: number } {
    const result = this.#deps.repository.applyBatch(input, this.#now());

    if (!result.applied) {
      return { applied: false, completed: 0 };
    }

    const touched = new Set(input.entries.map((entry) => entry.playerQuestId));
    let completed = 0;

    for (const playerQuestId of touched) {
      if (this.#completeIfDone(playerQuestId, 'plugin', null)) {
        completed += 1;
      }
    }

    return { applied: true, completed };
  }

  /**
   * O push do plugin diz que uma tentativa fechou.
   *
   * ####  ELE NÃO ACREDITA  ####
   *
   * O plugin propõe; aqui se confere com o número do agente. Se
   * não bater, NADA acontece — e isso não é erro: o lote de 60 s
   * chega logo e resolve. Confiar no plugin daria a recompensa a
   * partir de um contador que um `oxide.reload` pode ter esvaziado.
   *
   * @returns `true` se a tentativa passou a `completed` agora.
   */
  reportCompletion(input: {
    readonly playerQuestId: number;
    readonly eventId?: string | null;
  }): boolean {
    return this.#completeIfDone(input.playerQuestId, 'plugin', input.eventId ?? null);
  }

  /**
   * O pacote chegou: o jogador apertou USE no NPC de destino.
   *
   * ####  A ENTREGA É O ÚNICO OBJETIVO QUE NÃO CONTA, MARCA  ####
   *
   * Os outros seis somam um pouco de cada vez. A entrega acontece
   * de uma vez só, num lugar do mapa — e o plugin é o único que
   * pode saber que o jogador está lá.
   *
   * Daí ela não passar pelo lote: o lote traz DELTAS de coisas que
   * se acumulam, e "cheguei" não se acumula.
   *
   * ####  A CONFERÊNCIA AQUI É OUTRA  ####
   *
   * Não dá para conferir "chegou" com o número do agente — ele não
   * sabe onde ninguém está. O que se confere é o CONTRATO: existe
   * um objetivo de entrega, nesta tentativa, apontando para ESTE
   * NPC? Um push com o NPC errado não marca nada.
   *
   * @returns `true` se algum objetivo foi marcado agora.
   */
  reportDelivery(input: {
    readonly playerQuestId: number;
    readonly npcId: string;
    readonly eventId?: string | null;
  }): boolean {
    const attempt = this.#deps.repository.attempt(input.playerQuestId);

    if (attempt === null || attempt.status !== 'active') {
      return false;
    }

    const objective = attempt.snapshot.objectives.find(
      (item) => item.kind === 'deliver' && item.target === input.npcId,
    );

    if (objective === undefined) {
      // O plugin mandou uma entrega que esta tentativa não pediu.
      // Não é erro — o jogador pode ter apertado USE num NPC que é
      // destino de OUTRA missão dele.
      return false;
    }

    if ((attempt.progress[objective.seq] ?? 0) >= objective.amount) {
      // Já entregue. O USE repetido no mesmo NPC cai aqui.
      return false;
    }

    const now = this.#now();

    this.#deps.repository.setProgress(attempt.id, objective.seq, objective.amount, now);
    this.#deps.repository.recordEvent(
      {
        eventId: input.eventId ?? null,
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        questId: attempt.questId,
        attempt: attempt.attempt,
        kind: 'progress',
        detail: { objectiveSeq: objective.seq, delivered: input.npcId },
        source: 'plugin',
      },
      now,
    );

    // E o de sempre: se isto fechou a última pendência, a tentativa
    // conclui pelo MESMO caminho das outras.
    this.#completeIfDone(input.playerQuestId, 'plugin', null);

    return true;
  }

  /**
   * A distância entre os dois NPCs de uma entrega.
   *
   * ####  QUEM MEDE É O AGENTE, E NUNCA O PLUGIN  ####
   *
   * O push traz um `meters` que o plugin calculou, e ele é
   * IGNORADO: um cliente adulterado que dissesse ter andado 40 km
   * seria pago por 40 km. Aqui a conta sai das coordenadas que o
   * BANCO guarda — as mesmas que o admin cadastrou de pé no lugar.
   *
   * É plano (X/Z), e não 3D: a altura de um monumento não é
   * caminho andado, e incluí-la pagaria a mais por uma entrega
   * numa torre.
   *
   * `null` quando a quest não é de entrega, ou quando algum dos
   * dois NPCs sumiu — e aí a recompensa `perMeter` FALHA em vez de
   * pagar zero em silêncio.
   */
  deliveryDistanceOf(playerQuestId: number): number | null {
    const attempt = this.#deps.repository.attempt(playerQuestId);

    if (attempt === null) {
      return null;
    }

    const objective = attempt.snapshot.objectives.find((item) => item.kind === 'deliver');

    if (objective?.target === undefined || objective.target === null) {
      return null;
    }

    const quest = this.#deps.repository.get(attempt.questId);
    const origin = quest?.npcId === undefined || quest.npcId === null
      ? null
      : this.#deps.repository.getNpc(quest.npcId);
    const destination = this.#deps.repository.getNpc(objective.target);

    if (origin === null || destination === null) {
      return null;
    }

    return Math.hypot(destination.x - origin.x, destination.z - origin.z);
  }

  /**
   * O jogador resgata.
   *
   * ####  A ORDEM É A DO §6.4 DO PLANO, E ELA É DELIBERADA  ####
   *
   *   conferir -> marcar 'claimed' -> COMMIT -> entregar
   *
   * Marcar antes de entregar. O inverso — entregar e depois marcar
   * — dá, numa queda no meio, um jogador que recebeu duas vezes.
   * Neste sentido dá um jogador que precisa de um clique do admin,
   * e o painel mostra exatamente quem.
   *
   * É o oposto do que a loja faz (ela debita e estorna se falhar), e
   * a diferença é qual erro dói mais: lá o jogador PAGOU.
   *
   * @throws {ApiError} 404 tentativa inexistente, 409 quando ela
   * não está pronta para resgate.
   */
  async claim(input: {
    readonly playerQuestId: number;
    readonly actor?: string | null;
    /** A distância medida da entrega. Ver `DeliverRewardsInput`. */
    readonly distanceMeters?: number;
  }): Promise<ClaimResult> {
    const before = this.#deps.repository.attempt(input.playerQuestId);

    if (before === null) {
      throw new ApiError(
        'QUEST_ATTEMPT_NOT_FOUND',
        `Não existe a tentativa ${String(input.playerQuestId)}.`,
        404,
      );
    }

    if (before.status === 'claimed') {
      throw new ApiError('QUEST_ALREADY_CLAIMED', 'Esta quest já foi resgatada.', 409);
    }

    // Uma última chance de fechar: o jogador pode ter concluído
    // entre o último lote e o clique. Sem isto, ele veria a barra
    // cheia e o botão recusando.
    if (before.status === 'active') {
      this.refreshDerived({ serverId: before.serverId, steamId: before.steamId });
      this.#completeIfDone(input.playerQuestId, 'agent', null);
    }

    const attempt = this.#deps.repository.attempt(input.playerQuestId);

    if (attempt === null || attempt.status !== 'completed') {
      throw new ApiError(
        'QUEST_NOT_COMPLETE',
        'Esta quest ainda não foi concluída. Termine os objetivos primeiro.',
        409,
      );
    }

    // ####  O `consume` RODA ANTES DO PRÊMIO  ####
    //
    // §7.4 do plano. Se o material não sai, o resgate PARA aqui: a
    // missão continua `completed`, e o jogador junta o que falta e
    // volta. Entregar o prêmio sem cobrar o material daria os dois.
    const toConsume = attempt.snapshot.objectives.filter(
      (objective) => objective.consume && objective.target !== null,
    );

    if (toConsume.length > 0) {
      if (this.#deps.consumer === undefined) {
        throw new ApiError(
          'QUEST_CONSUME_UNAVAILABLE',
          'Esta missão precisa recolher os itens, e o servidor não consegue fazer isso agora.',
          503,
        );
      }

      const taken = await this.#deps.consumer.take({
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        items: toConsume.map((objective) => ({
          shortname: objective.target as string,
          amount: objective.amount,
        })),
      });

      if (!taken.complete) {
        throw new ApiError(
          'QUEST_CONSUME_INCOMPLETE',
          taken.missing ??
            'Você não está com todos os itens que esta missão pede. Junte o que falta e volte.',
          409,
        );
      }
    }

    const quest = this.#deps.repository.get(attempt.questId);
    const now = this.#now();

    // ####  E O COOLDOWN VEM DA QUEST DE HOJE, NÃO DO SNAPSHOT  ####
    //
    // O snapshot congela o que ela EXIGIA e PROMETIA — é o contrato
    // com o jogador. Quando ela volta é uma decisão de operação do
    // servidor, e mudá-la no painel precisa valer para todo mundo,
    // inclusive para quem aceitou antes.
    //
    // O `null` é defesa, e não um caso previsto: `player_quests`
    // referencia `quests` com ON DELETE CASCADE (migração 046,
    // CONFERIDO com PRAGMA foreign_keys ligado), então uma quest
    // apagada leva esta tentativa junto e o `attempt` acima já
    // teria devolvido 404. Fica porque custa nada e porque um dia
    // essa FK pode mudar.
    const cooldownUntil = quest === null ? null : this.#cooldownUntil(quest, attempt.serverId, now);

    if (!this.#deps.repository.claim(input.playerQuestId, cooldownUntil, now)) {
      // Outro clique ganhou a corrida entre a leitura e o UPDATE. O
      // `WHERE status = 'completed'` do repositório é quem impede a
      // entrega em dobro.
      throw new ApiError('QUEST_ALREADY_CLAIMED', 'Esta quest já foi resgatada.', 409);
    }

    this.#deps.repository.recordEvent(
      {
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        questId: attempt.questId,
        attempt: attempt.attempt,
        kind: 'claim',
        source: input.actor === undefined || input.actor === null ? 'agent' : 'panel',
        actor: input.actor ?? null,
      },
      now,
    );

    // ####  A DISTÂNCIA É MEDIDA AQUI, E NÃO RECEBIDA  ####
    //
    // Quem chama pode passá-la (o painel, num caso de suporte), mas
    // o normal é o agente medir: o jogador clicou em RESGATAR, e a
    // conta sai das coordenadas do banco. Ver `deliveryDistanceOf`.
    const distance = input.distanceMeters ?? this.deliveryDistanceOf(attempt.id) ?? undefined;
    this.#deps.onLiveChanged?.({ serverId: attempt.serverId, steamId: attempt.steamId });

    const outcomes = await this.#deliver(attempt, distance);

    return {
      playerQuestId: attempt.id,
      questId: attempt.questId,
      outcomes,
      pending: outcomes.some((item) => !item.ok),
    };
  }

  /**
   * Reentrega o que falhou.
   *
   * É o botão do painel. A tentativa continua `claimed` — ela nunca
   * deixou de estar —, e a idempotência de moeda e ponto (a
   * `reference` e o `eventId` estáveis) é o que torna repetir
   * seguro para esses dois. Item, kit e VIP saem de novo: por isso
   * o painel diz o que já foi.
   */
  async retryRewards(input: {
    readonly playerQuestId: number;
    readonly actor: string;
    readonly distanceMeters?: number;
  }): Promise<ClaimResult> {
    const attempt = this.#deps.repository.attempt(input.playerQuestId);

    if (attempt === null) {
      throw new ApiError(
        'QUEST_ATTEMPT_NOT_FOUND',
        `Não existe a tentativa ${String(input.playerQuestId)}.`,
        404,
      );
    }

    if (attempt.status !== 'claimed') {
      throw new ApiError(
        'QUEST_NOT_CLAIMED',
        'Só dá para reentregar a recompensa de uma quest já resgatada.',
        409,
      );
    }

    const distance = input.distanceMeters ?? this.deliveryDistanceOf(attempt.id) ?? undefined;
    const outcomes = await this.#deliver(attempt, distance, input.actor);

    return {
      playerQuestId: attempt.id,
      questId: attempt.questId,
      outcomes,
      pending: outcomes.some((item) => !item.ok),
    };
  }

  /**
   * Recalcula os objetivos que o plugin não conta.
   *
   * Idempotente e barata: uma consulta por métrica DISTINTA, e um
   * `setProgress` só quando o número mudou. Pode ser chamada em
   * todo ciclo do coletor sem custo perceptível.
   *
   * ####  E ALGUÉM PRECISA CHAMÁ-LA DE FORA DA TELA  ####
   *
   * Aqui ela roda no `liveFor` e no `claim` — os dois caminhos em
   * que o jogador está olhando. Isso não basta: "fique 60 minutos
   * online" de quem nunca abre o menu ficaria em zero para sempre,
   * e a quest jamais concluiria.
   *
   * O ciclo do coletor (frente C) precisa chamá-la para os
   * jogadores online, junto com o flush — é lá que a conclusão de
   * `playtime` e `metric` nasce. Sem isso o buraco é SILENCIOSO: o
   * módulo funciona inteiro, menos esses dois tipos de objetivo.
   */
  refreshDerived(input: { readonly serverId: string; readonly steamId: string }): void {
    const stats = this.#deps.stats;

    if (stats === undefined) {
      return;
    }

    const now = this.#now();
    const cache = new Map<string, number>();

    for (const attempt of this.#deps.repository.liveFor(input.serverId, input.steamId)) {
      if (attempt.status !== 'active') {
        continue;
      }

      for (const objective of attempt.snapshot.objectives) {
        const metric = metricOf(objective);

        if (metric === null) {
          continue;
        }

        let total = cache.get(metric);

        if (total === undefined) {
          total = stats.totalOf(input.serverId, input.steamId, metric);
          cache.set(metric, total);
        }

        const baseline = attempt.snapshot.baselines?.[objective.seq] ?? 0;
        // `Math.max(0, …)` porque o total pode ter sido zerado por
        // um reset de admin no ranking: o progresso para de andar,
        // mas nunca anda para trás.
        const raw = Math.max(0, total - baseline);
        const value = objective.kind === 'playtime' ? Math.floor(raw / 60) : raw;

        if ((attempt.progress[objective.seq] ?? 0) !== value) {
          this.#deps.repository.setProgress(attempt.id, objective.seq, value, now);
        }
      }
    }
  }

  // ======================================================
  //  Privados
  // ======================================================

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #nameOf(target: string | null): string {
    if (target === null) {
      return '?';
    }

    return this.#deps.items?.displayNameOf(target) ?? target;
  }

  #objectiveView(objective: QuestObjective, have: number): ObjectiveView {
    return {
      seq: objective.seq,
      label: this.describeObjective(objective),
      // O contador é capado na tela, e não no banco: o lote pode
      // trazer 300 de scrap para um objetivo de 250, e "300 / 250"
      // é feio sem ser mais informativo.
      have: Math.min(have, objective.amount),
      need: objective.amount,
      done: have >= objective.amount,
    };
  }

  /**
   * O snapshot do aceite, com a linha de partida das métricas.
   *
   * Ver `QuestSnapshot.baselines`: os objetivos `metric` e
   * `playtime` leem um TOTAL acumulado, e sem a partida quem já
   * tinha 4.000 abates concluiria "mate 20" na hora.
   */
  #snapshotOf(quest: QuestRecord, serverId: string, steamId: string): QuestSnapshot {
    const baselines: Record<number, number> = {};

    for (const objective of quest.objectives) {
      const metric = metricOf(objective);

      if (metric !== null) {
        baselines[objective.seq] = this.#deps.stats?.totalOf(serverId, steamId, metric) ?? 0;
      }
    }

    return {
      title: quest.title,
      objectives: quest.objectives,
      rewards: quest.rewards,
      baselines,
    };
  }

  /**
   * Por que esta quest não pode ser aceita agora.
   *
   * A ordem das checagens importa: a mais específica primeiro, para
   * que a frase que o jogador lê seja a mais útil. "Volta em 4h" é
   * melhor que "você já atingiu o limite de quests".
   */
  async #whyNot(input: {
    readonly quest: QuestRecord;
    readonly last: PlayerQuestRecord | null;
    readonly live: readonly PlayerQuestRecord[];
    readonly settings: QuestSettings;
    readonly now: number;
    readonly serverId: string;
    readonly steamId: string;
  }): Promise<QuestBlock | null> {
    const { quest, last, now } = input;

    if (!quest.enabled) {
      return { code: 'QUEST_DISABLED', reason: 'Esta quest não está disponível.' };
    }

    if (quest.availableFrom !== null && now < quest.availableFrom) {
      return { code: 'QUEST_NOT_YET', reason: 'Esta quest ainda não começou.' };
    }

    if (quest.availableTo !== null && now >= quest.availableTo) {
      return { code: 'QUEST_EXPIRED', reason: 'O prazo desta quest já passou.' };
    }

    // ####  A CADEIA  ####
    //
    // "Concluída" é ter chegado a `claimed`: parar em `completed`
    // sem resgatar deixaria destravar a próxima sem receber a
    // recompensa da anterior — e o jogador voltaria para pegá-la
    // depois, fora de ordem.
    if (quest.requiresQuest !== null) {
      const previous = this.#deps.repository.lastAttempt(
        input.serverId,
        input.steamId,
        quest.requiresQuest,
      );

      if (previous === null || previous.status !== 'claimed') {
        const name = this.#deps.repository.get(quest.requiresQuest)?.title ?? quest.requiresQuest;

        return {
          code: 'QUEST_NEEDS_PREVIOUS',
          reason: `Conclua "${name}" antes desta.`,
        };
      }
    }

    if (last !== null && last.status === 'claimed') {
      if (quest.repeatMode === 'once') {
        return { code: 'QUEST_ONCE_ONLY', reason: 'Esta quest só pode ser feita uma vez.' };
      }

      if (last.cooldownUntil !== null && now < last.cooldownUntil) {
        return {
          code: 'QUEST_ON_COOLDOWN',
          reason: `Esta quest volta em ${humanDelay(last.cooldownUntil - now)}.`,
        };
      }
    }

    // ####  O `requires` É POR ÚLTIMO ENTRE AS DA QUEST  ####
    //
    // Ele é o único que pode custar uma ida à rede (VIP, permissão
    // do Oxide). Perguntar antes de saber que a quest está em
    // cooldown seria pagar por uma resposta que não muda nada.
    if (quest.requires !== null) {
      if (this.#deps.permissions === undefined) {
        // Liberar o que não se sabe conferir entregaria a quest de
        // VIP para todo mundo. Recusar é o único desfecho seguro.
        return {
          code: 'QUEST_LOCKED',
          reason: 'Esta quest tem um requisito que o servidor não consegue conferir agora.',
        };
      }

      const allowed = await this.#deps.permissions.can({
        steamId: input.steamId,
        serverId: input.serverId,
        requires: quest.requires,
      });

      if (!allowed) {
        return { code: 'QUEST_LOCKED', reason: 'Você ainda não tem acesso a esta quest.' };
      }
    }

    // ####  A MISSÃO DE NPC SÓ SE PEGA NO BALCÃO  ####
    //
    // Ela aparece no menu desde 11/09/2026 (ver `offersFor`), e é
    // por isso que este bloqueio precisa existir: sem ele, o
    // cartaz viraria balcão e o boneco perderia a função.
    //
    // Quem responde "ele esteve lá?" é o empurrão do plugin, e não
    // o clique — ver `#npcTalks`. A frase diz o nome e as
    // coordenadas porque um NPC que ninguém acha é a mesma coisa
    // que um NPC que não existe.
    if (quest.npcId !== null) {
      const npc = this.#deps.repository.getNpc(quest.npcId);

      if (
        npc !== null &&
        npc.enabled &&
        !this.#talkedRecently({
          serverId: input.serverId,
          steamId: input.steamId,
          npcId: npc.id,
        })
      ) {
        return {
          code: 'QUEST_NEEDS_NPC',
          reason:
            `Fale com ${npc.name} para pegar esta missão. ` +
            `Ele fica em ${String(Math.round(npc.x))}, ${String(Math.round(npc.z))}.`,
        };
      }
    }

    // ####  O TETO É O ÚLTIMO DE TODOS  ####
    //
    // Porque ele não é sobre ESTA quest: dizer "você está no limite"
    // sobre uma que ele nem poderia pegar esconde o motivo de
    // verdade.
    if (input.settings.maxActive > 0 && input.live.length >= input.settings.maxActive) {
      return {
        code: 'QUEST_LIMIT_REACHED',
        reason:
          `Você já está com ${String(input.settings.maxActive)} quest(s) em andamento. ` +
          'Termine ou cancele uma para pegar outra.',
      };
    }

    return null;
  }

  /**
   * Marca `completed` se — e só se — todos os objetivos fecharam
   * pelo número DAQUI.
   *
   * @returns `true` quando a tentativa mudou de estado agora.
   */
  #completeIfDone(
    playerQuestId: number,
    source: 'plugin' | 'agent',
    eventId: string | null,
  ): boolean {
    const attempt = this.#deps.repository.attempt(playerQuestId);

    if (attempt === null || attempt.status !== 'active') {
      return false;
    }

    const done = attempt.snapshot.objectives.every(
      (objective) => (attempt.progress[objective.seq] ?? 0) >= objective.amount,
    );

    if (!done) {
      // O plugin disse que fechou e o agente discorda. Não é erro:
      // o lote de 60 s chega e resolve. Fica em `debug` porque num
      // servidor cheio isso acontece o tempo todo — o push chega
      // antes do lote que o sustenta.
      if (source === 'plugin') {
        this.#deps.logger.debug(
          { playerQuestId, questId: attempt.questId, steamId: attempt.steamId },
          'push de conclusão sem o número para sustentá-lo; o lote resolve',
        );
      }

      return false;
    }

    const now = this.#now();

    if (!this.#deps.repository.complete(playerQuestId, now)) {
      // O push e o lote trazem o mesmo fato de propósito. Chegar
      // aqui é o caso normal da segunda chegada.
      return false;
    }

    this.#deps.repository.recordEvent(
      {
        eventId,
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        questId: attempt.questId,
        attempt: attempt.attempt,
        kind: 'complete',
        source,
      },
      now,
    );

    this.#deps.logger.info(
      {
        serverId: attempt.serverId,
        steamId: attempt.steamId,
        questId: attempt.questId,
        attempt: attempt.attempt,
        source,
      },
      'quest concluída',
    );

    return true;
  }

  async #deliver(
    attempt: PlayerQuestRecord,
    distanceMeters: number | undefined,
    actor?: string,
  ): Promise<readonly RewardOutcome[]> {
    if (this.#deps.rewards === undefined) {
      // Sem o entregador, a quest fica resgatada e a recompensa
      // vira pendência — que é exatamente o que o painel lista.
      const outcomes = attempt.snapshot.rewards.map((reward) => ({
        kind: reward.kind,
        ok: false,
        code: 'QUEST_REWARD_UNAVAILABLE',
        message: 'Este agente não está entregando recompensas agora.',
      }));

      this.#recordFailures(attempt, outcomes, actor);

      return outcomes;
    }

    const outcomes = await this.#deps.rewards.deliver({
      serverId: attempt.serverId,
      steamId: attempt.steamId,
      questId: attempt.questId,
      attempt: attempt.attempt,
      questTitle: attempt.snapshot.title,
      rewards: attempt.snapshot.rewards,
      distanceMeters,
    });

    this.#recordFailures(attempt, outcomes, actor);

    return outcomes;
  }

  /**
   * O que não saiu vira linha na auditoria.
   *
   * Uma por recompensa, e não uma por resgate: "o kit falhou" e "os
   * coins falharam" são pendências diferentes, e o painel reentrega
   * o que precisa.
   *
   * Sem `eventId`: ele é único na tabela, e uma reentrega que
   * falhasse de novo seria engolida pelo `INSERT OR IGNORE` — que é
   * justamente a linha que o admin precisa ver.
   */
  #recordFailures(
    attempt: PlayerQuestRecord,
    outcomes: readonly RewardOutcome[],
    actor: string | undefined,
  ): void {
    const now = this.#now();

    for (const outcome of outcomes) {
      if (outcome.ok) {
        continue;
      }

      this.#deps.repository.recordEvent(
        {
          serverId: attempt.serverId,
          steamId: attempt.steamId,
          questId: attempt.questId,
          attempt: attempt.attempt,
          kind: 'reward_failed',
          detail: { kind: outcome.kind, code: outcome.code, message: outcome.message },
          source: actor === undefined ? 'agent' : 'panel',
          actor: actor ?? null,
        },
        now,
      );
    }
  }

  /**
   * Quando esta quest volta a estar disponível.
   *
   * `null` = nunca (`once`), ou já pode.
   */
  #cooldownUntil(quest: QuestRecord, serverId: string, now: number): number | null {
    switch (quest.repeatMode) {
      case 'once':
        return null;
      case 'cooldown':
        return now + quest.cooldownSeconds * 1000;
      case 'daily':
        return nextReset(now, this.#deps.repository.settingsOf(serverId).resetAtMinute, 1);
      case 'weekly':
        return nextReset(now, this.#deps.repository.settingsOf(serverId).resetAtMinute, 7);
    }
  }
}

// ------------------------------------------------------------
//  §4  FUNÇÕES PURAS
// ------------------------------------------------------------

/** A métrica de um objetivo que o AGENTE conta. `null` nos do plugin. */
function metricOf(objective: QuestObjective): string | null {
  if (objective.kind === 'metric') {
    return objective.metric;
  }

  // `time.played` é o mesmo nome que o coletor do ranking usa
  // (rankings/collector.ts). Duas constantes para a mesma métrica
  // divergiriam no dia em que uma delas fosse renomeada.
  return objective.kind === 'playtime' ? 'time.played' : null;
}

/**
 * A próxima virada, `days` dias à frente.
 *
 * ####  ELA CONTA DIAS DE CALENDÁRIO, E NÃO 24 h  ####
 *
 * `+ 86.400.000` erra na semana em que o horário de verão muda, e o
 * erro é de uma hora numa direção que ninguém percebe até a diária
 * virar às 23h ou à 1h. Construir a data pelo calendário local e
 * somar no CAMPO do dia acerta os dois casos.
 *
 * Exportada para o teste: é aritmética de fuso, o tipo de coisa
 * que se prova com exemplos e não olhando.
 */
export function nextReset(now: number, resetAtMinute: number, days: number): number {
  const date = new Date(now);
  const target = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    resetAtMinute,
    0,
    0,
  );

  // A virada de hoje ainda não passou e estamos pedindo a de
  // amanhã: `days - 1`, para "diária" querer dizer a PRÓXIMA
  // virada, e não a de depois dela.
  const ahead = target.getTime() > now ? days - 1 : days;

  target.setDate(target.getDate() + ahead);

  return target.getTime();
}

/**
 * "4h", "12min", "3 dias".
 *
 * Uma casa só: a tela do jogo tem pouca largura, e "3 dias, 4 horas
 * e 12 minutos" não cabe nem ajuda quem só quer saber se volta hoje.
 */
export function humanDelay(ms: number): string {
  if (ms <= MINUTE_MS) {
    return 'menos de um minuto';
  }

  if (ms < 60 * MINUTE_MS) {
    return `${String(Math.round(ms / MINUTE_MS))}min`;
  }

  if (ms < DAY_MS) {
    return `${String(Math.round(ms / (60 * MINUTE_MS)))}h`;
  }

  const days = Math.round(ms / DAY_MS);

  return `${String(days)} dia${days === 1 ? '' : 's'}`;
}
