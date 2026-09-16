// ============================================================
//  collector.ts  -  o relógio que traz o progresso do jogo.
//
//  ####  ESTE É O CAMINHO "PULL", E ELE FAZ TRÊS COISAS  ####
//
//    1. desce o CATÁLOGO do que observar (`watch`);
//    2. pagina o `flush` e aplica o lote numa transação só;
//    3. RECALCULA os objetivos que o plugin não conta.
//
//  O passo 3 é o que fecha o buraco que a frente B deixou escrito:
//  `metric` e `playtime` são lidos de `player_stats`, e ninguém os
//  empurra. Sem esta chamada, "fique 60 minutos online" de quem
//  nunca abre o menu fica em zero PARA SEMPRE — e o módulo parece
//  funcionar inteiro, menos esses dois tipos de objetivo.
//
//  O outro canal — o marcador `#OZQUEST#` no console — dá o
//  "agora" para o recibo no chat, e mora em `quests/events.ts`. Os
//  dois carregam o mesmo `eventId`, e quem desempata é a tabela
//  `quest_events`.
//
//  ------------------------------------------------------------
//  ####  A ORDEM DA RODADA NÃO É ARBITRÁRIA  ####
//
//    1. o módulo está ligado neste servidor?  não → passa adiante
//    2. o catálogo mudou?                     sim → `watch`
//    3. pagina o `flush` até o fim
//    4. aplica TUDO, e conclui o que fechou
//    5. `ack` — depois do COMMIT, sempre
//    6. recalcula os derivados dos que estão online
//
//  O passo 5 vem depois do 4 porque confirmar antes de gravar troca
//  uma duplicata inofensiva — que o `batchId` recusa em
//  `quest_batches` — por uma perda silenciosa.
//
//  ------------------------------------------------------------
//  ####  `sweep()` NUNCA LANÇA  ####
//
//  Servidor parado, RCON caído, plugin que não compila: tudo isso é
//  rotina. Uma exceção que escapasse pararia a coleta para sempre,
//  em silêncio — o pior jeito de um relógio falhar. O try/catch é
//  POR SERVIDOR, e a volta seguinte tenta de novo.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §8 e §9.
// ============================================================

import type { QuestsRepository } from '../db/quests-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import {
  containerSetsOf,
  describeContainerSelectors,
} from '../game/quest-containers.js';
import {
  buildAckCommand,
  buildAssignCommand,
  buildFlushCommand,
  buildWatchCommand,
  QUEST_COMMANDS,
  QUEST_FLUSH_DEFAULT_LIMIT,
  QUEST_PAYLOAD_TOO_LARGE,
  QUESTS_CONTRACT,
  questErrorSchema,
  questFlushSchema,
  questWatchReplySchema,
  type QuestAssignPayload,
  type QuestWatchPayload,
} from '../game/quests-contract.js';
import type { Logger } from '../logger.js';
import { PLUGIN_OBJECTIVE_KINDS } from '../types/quests.js';
import type { QuestsService } from './service.js';

/** O que o coletor precisa de um RCON. E nada além disso. */
export interface QuestCollectorRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

export interface QuestCollectorServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: QuestCollectorRcon } | null;
}

/** Quem está online agora, naquele servidor. */
export interface QuestPresence {
  /** `null` = não deu para perguntar. É DIFERENTE de lista vazia. */
  online(serverId: string): Promise<readonly string[] | null>;
}

export interface QuestCollectorDeps {
  readonly repository: QuestsRepository;
  readonly service: QuestsService;
  readonly servers: QuestCollectorServers;
  readonly presence: QuestPresence;
  readonly logger: Logger;
  /** O segredo do `#OZQUEST#`, sorteado a cada subida. */
  readonly secret: string;
  /**
   * Os NPCs, que descem na MESMA rodada.
   *
   * Aqui, e não num relógio próprio: os dois têm o mesmo gatilho —
   * "o RCON está de pé e o catálogo mudou" — e dois relógios para
   * a mesma pergunta dariam dois momentos em que o mundo e o banco
   * podem divergir.
   *
   * Ausente = a frente dos NPCs não está montada, e as quests de
   * menu continuam funcionando inteiras.
   */
  readonly npcs?: {
    push(serverId: string): Promise<void>;
    /**
     * Esquece o que aquele servidor já teria.
     *
     * Sem isto, um plugin que recarregou fica SEM os bonecos: o
     * agente acha que já os mandou, e a impressão digital não muda
     * sozinha. Ver `handleLine`.
     */
    forget(serverId?: string): void;
  };
  readonly now?: () => number;
}

/**
 * A normalização das criaturas do Rust.
 *
 * ####  ELA MORA AQUI, E NÃO NO C#  ####
 *
 * O `ShortPrefabName` é o que o jogo entrega; `scientist` é o que o
 * admin cadastra no painel. O `Quests.cs` acerta isso no C# — e é
 * por isso que uma criatura nova do Rust exigiria um release do
 * plugin dele.
 *
 * Aqui a tabela desce no `watch`, e uma criatura nova é uma linha
 * neste arquivo.
 *
 * ####  SÓ O QUE O PREFIXO NÃO PEGA  ####
 *
 * Os 25 `scientistnpc_*` do build saíram daqui em 15/09/2026: quem
 * responde por eles é `CREATURE_ALIAS_PREFIXES`. O que sobrou é o
 * que nenhuma regra alcança — nome próprio, e nada mais.
 *
 * Prefabs MEDIDOS no build do server01 em 15/09/2026, com a sonda
 * de `ozprobe.types`. Não são de documentação: `scientistnpc_ordinary`
 * estava nesta tabela e não existe no jogo há tempos.
 */
export const CREATURE_ALIASES: Readonly<Record<string, string>> = {
  ridablehorse: 'horse',
  ridablehorse2: 'horse',
  // O lobo virou `Rust.Ai.Gen2.Wolf2`, e o prefab foi junto.
  wolf2: 'wolf',
  npc_tunneldweller: 'tunneldweller',
  npc_underwaterdweller: 'underwaterdweller',
  'snake.entity': 'snake',
};

/**
 * A normalização do prefab que AINDA NÃO EXISTE.
 *
 * ####  POR QUE UMA TABELA EXATA NÃO BASTA  ####
 *
 * Em 15/09/2026 a missão de matar cientista estava parada, e nada
 * no agente nem no plugin havia mudado. O que mudou foi o jogo: a
 * Facepunch migrou o cientista para `Rust.Ai.Gen2.ScientistNPC2`,
 * com prefabs novos (`scientist2`, `scientist2.heavy`,
 * `scientist2.shotgun`) que a tabela exata não conhecia.
 *
 * Uma tabela exata só erra assim — em silêncio, e sempre depois de
 * um wipe. O prefixo é o que faz o próximo `scientistnpc_<algo>` já
 * nascer contando.
 *
 * ####  A ORDEM IMPORTA, E A TABELA EXATA VEM ANTES  ####
 *
 * O plugin só consulta esta lista quando `CREATURE_ALIASES` não
 * respondeu — é o que permite uma exceção a uma regra de prefixo.
 *
 * Deliberadamente curta: prefixo é rede, não atalho. Um `bear` aqui
 * arrastaria `bear_tutorial` junto, e essa decisão deve ser
 * explícita na tabela de cima.
 */
export const CREATURE_ALIAS_PREFIXES: Readonly<Record<string, string>> = {
  // Os 25 do build: _arena, _bradley, _cargo, _ch47_gunner,
  // _excavator, _full_*, _heavy, _junkpile_pistol, _oilrig,
  // _outbreak, _patrol, _peacekeeper, _ptboat, _rhib, _roam,
  // _roamtethered...  e o que vier no próximo wipe.
  scientistnpc_: 'scientist',
  // A geração nova: `scientist2`, `scientist2.heavy`,
  // `scientist2.shotgun`. Sem o `_` de propósito — o prefab base
  // chama-se `scientist2`, sem sufixo nenhum.
  scientist2: 'scientist',
};

/**
 * O `ShortPrefabName` como o plugin vai lê-lo.
 *
 * ####  ESTE É O ESPELHO, E O PLUGIN É O ORIGINAL  ####
 *
 * Quem normaliza de verdade é o `QuestNormalize` do
 * `OrigemZAgent.cs`, dentro do jogo. Esta função existe para que a
 * regra possa ser AFIRMADA em teste contra os prefabs medidos —
 * sem ela, "o lobo conta" seria uma opinião até alguém abrir o Rust.
 *
 * A ordem é a mesma dos dois lados, e é ela que dá o resultado: a
 * tabela exata primeiro (é onde mora a exceção), o prefixo depois.
 */
export function normalizeCreature(prefab: string): string {
  const exact = CREATURE_ALIASES[prefab];

  if (exact !== undefined) {
    return exact;
  }

  for (const [prefix, target] of Object.entries(CREATURE_ALIAS_PREFIXES)) {
    if (prefab.startsWith(prefix)) {
      return target;
    }
  }

  return prefab;
}

/** O marcador do pedido. O mesmo do resto do agente. */
const REQUEST_MARKER = '#OZAREQ#';
/** O assunto. Ver `RequestQuests` no plugin. */
const REQUEST_TOPIC = 'quests';

/**
 * De quanto em quanto tempo o relógio bate.
 *
 * É o MENOR `flushSeconds` que a configuração aceita (15 s): quem
 * decide o ritmo de verdade é cada servidor, e o relógio só precisa
 * bater rápido o bastante para não atrasar o mais apressado.
 */
const TICK_MS = 15_000;

export interface QuestSweepResult {
  readonly serverId: string;
  readonly status: 'skipped' | 'applied' | 'failed';
  readonly reason?: string;
  readonly entries: number;
  readonly completed: number;
  /** Quantos jogadores tiveram os derivados recalculados. */
  readonly refreshed: number;
}

export class QuestCollector {
  readonly #deps: QuestCollectorDeps;
  /**
   * O catálogo que cada servidor já tem.
   *
   * Mandar o `watch` a cada rodada seria um comando de RCON por
   * minuto por servidor para dizer a mesma coisa. Guardar o que já
   * foi é o que reduz isso a "só quando muda" — e o `#OZAREQ#` do
   * plugin cobre o caso em que ele esquece (um `oxide.reload`).
   */
  readonly #sent = new Map<string, string>();
  /**
   * Quando cada servidor foi varrido pela última vez.
   *
   * É o que faz o `flushSeconds` de `quest_settings` valer de
   * verdade: o relógio bate no menor intervalo possível e cada
   * servidor só é perguntado quando o SEU tempo passou. Sem isto, o
   * campo estaria no painel sem efeito nenhum — e um campo que não
   * faz nada é pior que campo nenhum.
   */
  readonly #lastSweep = new Map<string, number>();
  /**
   * O que cada jogador já recebeu, por `<servidor>:<steamId>`.
   *
   * Sem isto, o `assign` de todo mundo sairia a cada 15 s: num
   * servidor de 150 jogadores, 150 comandos de RCON por rodada para
   * dizer o que já foi dito. Com isto, ele sai quando o jogador
   * aceita, cancela, conclui — ou entra.
   */
  readonly #assigned = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: QuestCollectorDeps) {
    this.#deps = deps;
  }

  /**
   * Liga o relógio.
   *
   * Ele bate a cada `TICK_MS`, e cada servidor decide se é a vez
   * dele pelo `flushSeconds` próprio.
   */
  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      // `void` com o erro tratado dentro: o `sweep` nunca lança, e
      // uma promessa não aguardada aqui é o que mantém o relógio no
      // ritmo mesmo com um servidor lento.
      void this.sweep();
    }, TICK_MS);

    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma rodada em todos os servidores.
   *
   * Não lança. Ver o cabeçalho.
   */
  async sweep(): Promise<readonly QuestSweepResult[]> {
    const results: QuestSweepResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.#sweepOne(serverId));
    }

    return results;
  }

  /**
   * Vai buscar o número AGORA, sem esperar a vez daquele servidor.
   *
   * ####  O PUSH DE CONCLUSÃO NÃO SE SUSTENTA SOZINHO  ####
   *
   * MEDIDO no servidor em 07/09/2026: o jogador matou o terceiro
   * cientista, o plugin gritou `#OZQUEST#` com a conclusão, e o
   * agente RECUSOU — corretamente, porque o contador dele ainda
   * estava em 1. A quest só fechou 78 segundos depois, quando o
   * lote do relógio trouxe o número.
   *
   * Do lado de quem joga, isso é "matei o último e não aconteceu
   * nada" — que é exatamente o que o canal do "agora" existe para
   * evitar.
   *
   * Aqui o push que não se sustenta deixa de esperar o relógio e
   * MANDA BUSCAR. A guarda de `flushSeconds` é limpa só para este
   * servidor: é uma ida a mais ao RCON no instante em que alguém
   * concluiu uma missão, e não um intervalo menor para todo mundo
   * o tempo inteiro.
   */
  async flushNow(serverId: string): Promise<QuestSweepResult> {
    this.#lastSweep.delete(serverId);

    return this.#sweepOne(serverId);
  }

  /**
   * Força o reenvio do catálogo na próxima rodada.
   *
   * É o que a rota de escrita chama depois de gravar uma quest: sem
   * isso, um alvo novo só passaria a ser contado quando alguma
   * outra coisa mudasse o catálogo.
   *
   * Também é o caminho do `#OZAREQ#` — o plugin gritando que
   * esqueceu.
   */
  forget(serverId?: string): void {
    if (serverId === undefined) {
      this.#sent.clear();
      this.#assigned.clear();
      this.#lastSweep.clear();
    } else {
      this.#sent.delete(serverId);

      // ####  O QUE CADA JOGADOR PERSEGUE TAMBÉM SE PERDE  ####
      //
      // O `assign` mora na memória do plugin junto com o catálogo, e
      // some no mesmo `oxide.reload`. Sem esta limpeza o agente acha
      // que já mandou: o jogador fica com a missão viva no banco e o
      // plugin sem saber o que contar — e a caixa do NPC oferece de
      // novo o que ele acabou de pegar, que foi o que o teste de
      // 12/09/2026 estranhou.
      for (const key of [...this.#assigned.keys()]) {
        if (key.startsWith(`${serverId}:`)) {
          this.#assigned.delete(key);
        }
      }

      // ####  ESQUECER SEM APAGAR O RELÓGIO NÃO ADIANTA  ####
      //
      // O `flushSeconds` do servidor pode ser 60 s, e a rodada que
      // reenviaria o catálogo seria pulada com "ainda não é a vez
      // dele" — um minuto inteiro em que o plugin está sem saber o
      // que contar. Quem esqueceu quer o reenvio, e o próximo tique
      // (15 s) é o mais cedo que ele pode acontecer.
      this.#lastSweep.delete(serverId);
    }
  }

  // ------------------------------------------------------

  async #sweepOne(serverId: string): Promise<QuestSweepResult> {
    const base = { serverId, entries: 0, completed: 0, refreshed: 0 } as const;

    try {
      const settings = this.#deps.repository.settingsOf(serverId);

      if (!settings.enabled) {
        return { ...base, status: 'skipped', reason: 'módulo desligado neste servidor' };
      }

      // O `flushSeconds` DAQUELE servidor. Ver `#lastSweep`.
      const now = this.#deps.now?.() ?? Date.now();
      const last = this.#lastSweep.get(serverId);

      if (last !== undefined && now - last < settings.flushSeconds * 1000) {
        return { ...base, status: 'skipped', reason: 'ainda não é a vez dele' };
      }

      const rcon = this.#deps.servers.contextOf(serverId)?.rcon;

      if (rcon === undefined || !rcon.isConnected) {
        // Servidor parado é rotina, e não erro. A volta seguinte
        // tenta de novo.
        return { ...base, status: 'skipped', reason: 'sem RCON' };
      }

      // Marcado ANTES do trabalho: um servidor que demore mais que
      // o intervalo dele não pode entrar duas vezes na fila.
      this.#lastSweep.set(serverId, now);

      await this.#pushWatch(serverId, rcon, settings.lootEnabled);

      // Os NPCs, no mesmo fôlego. Uma falha aqui NÃO derruba o
      // lote: o progresso do jogo é mais importante que um boneco
      // que não subiu, e a rodada seguinte tenta de novo.
      try {
        await this.#deps.npcs?.push(serverId);
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, err: error },
          'os NPCs de missão não subiram; tento de novo na próxima volta',
        );
      }

      const lote = await this.#flush(serverId, rcon);
      const refreshed = await this.#refreshOnline(serverId, rcon);

      return { ...base, status: 'applied', ...lote, refreshed };
    } catch (error) {
      this.#deps.logger.warn(
        { server: serverId, err: error },
        'a rodada de missões falhou; tento de novo na próxima volta',
      );

      return { ...base, status: 'failed', reason: String(error) };
    }
  }

  /**
   * Desce o catálogo, se ele mudou.
   *
   * ####  A LISTA DE `loot` PODE VIR VAZIA DE PROPÓSITO  ####
   *
   * `lootEnabled: false` na configuração do servidor esvazia a
   * lista mesmo havendo missão de loot cadastrada — e uma lista
   * vazia faz o plugin NÃO REGISTRAR o hook mais quente do jogo.
   * É a válvula que o `origemz.quest.diag` existe para informar.
   */
  async #pushWatch(
    serverId: string,
    rcon: QuestCollectorRcon,
    lootEnabled: boolean,
  ): Promise<void> {
    const watch: Record<string, string[]> = {};

    for (const entry of this.#deps.repository.watchFor(serverId)) {
      if (entry.kind === 'loot' && !lootEnabled) {
        continue;
      }

      (watch[entry.kind] ??= []).push(entry.target);
    }

    const payload: QuestWatchPayload = {
      contract: QUESTS_CONTRACT,
      secret: this.#deps.secret,
      watch,
      alias: CREATURE_ALIASES,
      aliasPrefix: CREATURE_ALIAS_PREFIXES,
      // Só as categorias em uso. Um servidor sem missão de saque
      // recebe `{}` e não paga por nada disto.
      sets: containerSetsOf(this.#deps.repository.containerSelectorsFor(serverId)),
    };

    // A comparação é do JSON, e não da lista: o `watchFor` já
    // ordena, então o mesmo catálogo produz sempre a mesma string.
    //
    // Os conjuntos entram na conta porque eles TAMBÉM mudam sozinhos
    // — um contêiner novo no catálogo do agente muda o que
    // `@barrel` alcança, e o plugin precisa saber.
    // ####  A NORMALIZAÇÃO ENTRA NA DIGITAL  ####
    //
    // Ela ficou de fora até 15/09/2026, e o preço era invisível:
    // corrigir um alias não reenviava nada para quem já estava
    // sincronizado, e o plugin seguia com a tabela velha até o
    // próximo `oxide.reload`. O conserto do lobo teria "não pegado"
    // em servidor nenhum que já estivesse de pé.
    const fingerprint = JSON.stringify({
      watch: payload.watch,
      sets: payload.sets,
      alias: payload.alias,
      aliasPrefix: payload.aliasPrefix,
    });

    if (this.#sent.get(serverId) === fingerprint) {
      return;
    }

    const reply = await rcon.send(buildWatchCommand(payload));

    this.#sent.set(serverId, fingerprint);

    this.#deps.logger.info(
      { server: serverId, alvos: Object.values(watch).flat().length },
      'catálogo de missões enviado ao plugin',
    );

    this.#warnIfPluginCannotCount(serverId, reply, watch);
  }

  /**
   * O plugin daquele servidor sabe contar o que foi pedido?
   *
   * ####  UM RECURSO INERTE PRECISA GRITAR  ####
   *
   * O objetivo `container` é aditivo no contrato: um
   * `OrigemZAgent.cs` anterior a 14/09/2026 recebe a chave nova,
   * guarda-a e nunca a usa. Nada quebra — e é justamente esse o
   * problema: a missão fica cadastrada, o jogador quebra barril, e o
   * contador não anda sem que nada explique por quê.
   *
   * Só o log, e nunca uma exceção: a rodada tem de seguir. E só
   * quando há o que contar — um servidor sem missão de saque não
   * precisa ouvir sobre um plugin que ele nunca vai usar.
   */
  #warnIfPluginCannotCount(
    serverId: string,
    reply: string,
    watch: Readonly<Record<string, readonly string[]>>,
  ): void {
    if ((watch.container?.length ?? 0) === 0) {
      return;
    }

    const parsed = questWatchReplySchema.safeParse(firstJsonLine(reply));

    // Resposta ilegível não vira alarme: o RCON pode ter cortado a
    // linha, e o `flush` da mesma rodada já denuncia um plugin que
    // não responde de verdade.
    if (!parsed.success || parsed.data.kinds === undefined) {
      this.#deps.logger.warn(
        { server: serverId },
        'este servidor tem missão de saque de contêiner, mas o plugin não diz que sabe contá-la; ' +
          'copie o OrigemZAgent.cs desta versão para o servidor',
      );

      return;
    }

    if (!parsed.data.kinds.includes('container')) {
      this.#deps.logger.warn(
        { server: serverId, kinds: parsed.data.kinds },
        'o plugin deste servidor não conta saque de contêiner; a missão não vai progredir até ' +
          'o OrigemZAgent.cs ser atualizado',
      );
    }
  }

  /**
   * Pagina o lote e aplica.
   *
   * O `ack` sai DEPOIS de tudo aplicado. Ver o cabeçalho.
   */
  async #flush(
    serverId: string,
    rcon: QuestCollectorRcon,
  ): Promise<{ readonly entries: number; readonly completed: number }> {
    let offset = 0;
    let limit = QUEST_FLUSH_DEFAULT_LIMIT;
    let batchId: string | null = null;

    // ####  AS PÁGINAS SE ACUMULAM, E SÓ ENTÃO SE APLICAM  ####
    //
    // MEDIDO por teste: as páginas de um lote carregam o MESMO
    // `batchId` — é ele que congela o lote no plugin. E a
    // idempotência do `applyBatch` é POR `batchId`: aplicar página
    // por página faria a segunda ser recusada como "já aplicado", e
    // o progresso de todo mundo depois da centésima linha sumiria
    // em silêncio.
    //
    // Acumular também é o certo pelo outro lado: uma transação só
    // para o lote inteiro, como o coletor do ranking já faz.

    const collected: {
      readonly playerQuestId: number;
      readonly objectiveSeq: number;
      readonly delta: number;
    }[] = [];

    // O teto de voltas existe para um plugin que respondesse
    // `total` maior do que entrega: sem ele, o laço não terminaria.
    for (let round = 0; round < 50; round += 1) {
      const raw = await rcon.send(buildFlushCommand(offset, limit, this.#deps.secret));
      const line = firstJsonLine(raw);
      const parsed = questFlushSchema.safeParse(line);

      if (!parsed.success) {
        const failure = questErrorSchema.safeParse(line);

        if (failure.success && failure.data.error === QUEST_PAYLOAD_TOO_LARGE) {
          // A página não coube. Reduz e pede DE NOVO, sem avançar o
          // offset: avançar perderia as linhas que estavam nela.
          limit = Math.max(10, Math.floor(limit / 2));
          continue;
        }

        // "Não consegui perguntar" nunca vira "ninguém progrediu": o
        // lote fica no plugin, sem `ack`, e volta na próxima rodada.
        throw new Error(
          `resposta inválida do plugin: ${failure.success ? failure.data.error : JSON.stringify(line)?.slice(0, 200)}`,
        );
      }

      batchId = parsed.data.batchId;

      for (const entry of parsed.data.entries) {
        collected.push({
          playerQuestId: entry.pq,
          objectiveSeq: entry.seq,
          delta: entry.delta,
        });
      }

      offset += parsed.data.entries.length;

      if (offset >= parsed.data.total || parsed.data.entries.length === 0) {
        break;
      }
    }

    if (batchId === null) {
      return { entries: 0, completed: 0 };
    }

    const applied = this.#deps.service.applyBatch({
      serverId,
      batchId,
      entries: collected,
    });

    // Depois do COMMIT, sempre. Um `ack` que falhe é inofensivo: o
    // lote volta e o `batchId` o recusa.
    await rcon.send(buildAckCommand(batchId));

    return { entries: collected.length, completed: applied.completed };
  }

  /**
   * Recalcula `metric` e `playtime` de quem está online.
   *
   * ####  É ESTE PASSO QUE A FRENTE B PEDIU POR ESCRITO  ####
   *
   * O `refreshDerived` roda no `liveFor` e no `claim` — os caminhos
   * em que o jogador está olhando. Isso não basta: "fique 60
   * minutos online" de quem nunca abre o menu ficaria em zero para
   * sempre.
   *
   * Só de quem está ONLINE: um jogador desconectado não acumula
   * tempo nem métrica, e varrer o banco inteiro a cada minuto
   * custaria uma consulta por jogador da história do servidor.
   *
   * `null` do presence = não deu para perguntar. Aí NÃO se
   * recalcula nada — é diferente de "ninguém online", e tratar os
   * dois igual não muda o resultado aqui, mas o log precisa dizer
   * qual foi.
   */
  async #refreshOnline(serverId: string, rcon: QuestCollectorRcon): Promise<number> {
    const online = await this.#deps.presence.online(serverId);

    if (online === null) {
      return 0;
    }

    for (const steamId of online) {
      // ####  A ORDEM DOS TRÊS PASSOS IMPORTA  ####
      //
      //   1. abrir as automáticas — a diária tem de existir antes
      //      de ser mandada ao plugin;
      //   2. recalcular os derivados — `playtime` e `metric` podem
      //      ter fechado, e uma missão concluída sai do `assign`;
      //   3. mandar o que sobrou.
      //
      // Inverter 1 e 3 faria a diária de hoje só chegar ao plugin
      // na rodada seguinte — quinze segundos em que minerar não
      // contava.
      await this.#deps.service.autoAcceptFor({ serverId, steamId });
      this.#deps.service.refreshDerived({ serverId, steamId });
      await this.#pushAssign(serverId, steamId, rcon);
    }

    // Quem saiu não precisa mais ocupar memória no plugin nem
    // cache aqui. O `forget` é barato e o plugin o trata como
    // rotina.
    const present = new Set(online);

    for (const key of [...this.#assigned.keys()]) {
      if (!key.startsWith(`${serverId}:`)) {
        continue;
      }

      const steamId = key.slice(serverId.length + 1);

      if (!present.has(steamId)) {
        this.#assigned.delete(key);
        await rcon.send(`${QUEST_COMMANDS.forget} ${steamId}`);
      }
    }

    return online.length;
  }

  /**
   * Manda ao plugin o que aquele jogador está perseguindo.
   *
   * ####  SÓ O QUE O PLUGIN TEM COMO CONTAR  ####
   *
   * `playtime` e `metric` ficam de fora: o agente os calcula do
   * lote que o ranking já traz, e pedir ao plugin que os conte
   * seria pedir o que ele não sabe.
   *
   * Uma tentativa sem NENHUM objetivo do plugin — uma missão só de
   * tempo online — não entra na lista. Ela existe, conta e conclui;
   * só não passa por aqui.
   */
  async #pushAssign(
    serverId: string,
    steamId: string,
    rcon: QuestCollectorRcon,
  ): Promise<void> {
    const quests: QuestAssignPayload['quests'][number][] = [];

    // ####  AS CONCLUÍDAS VÃO JUNTO  ####
    //
    // O plugin precisa delas para o balcão do NPC: sem saber que a
    // missão fechou, ele oferece ACEITAR na que o jogador acabou de
    // terminar — e o agente responde "você já está fazendo". Foi o
    // que o teste de 12/09/2026 encontrou.
    //
    // Elas descem com `status: 'completed'`, e o plugin não conta
    // progresso nelas.
    for (const attempt of this.#deps.repository.liveFor(serverId, steamId)) {
      if (attempt.status !== 'active' && attempt.status !== 'completed') {
        continue;
      }

      const objectives = attempt.snapshot.objectives
        .filter(
          (objective) =>
            // O saque de contêiner é o único que não tem alvo
            // ÚNICO: o que ele persegue é a lista. Sem esta
            // exceção ele seria descartado aqui, e a missão
            // desceria ao plugin sem o objetivo que a define.
            (objective.target !== null ||
              (objective.kind === 'container' && (objective.targets?.length ?? 0) > 0)) &&
            PLUGIN_OBJECTIVE_KINDS.includes(objective.kind),
        )
        .map((objective) => ({
          seq: objective.seq,
          kind: objective.kind,
          target: objective.target ?? '',
          // Só no saque, e cru: `@barrel` continua `@barrel`, e
          // quem o resolve é o plugin, contra o `sets` do `watch`.
          ...(objective.targets === null ? {} : { targets: objective.targets }),
          // ####  A ENCOMENDA VIAJA, E NADA MAIS MUDA  ####
          //
          // O campo só aparece quando existe. Assim o payload de
          // quem não usa encomenda continua byte a byte o mesmo —
          // e a impressão digital do `assign` não reenvia o mundo
          // inteiro por uma coluna nova.
          ...(objective.item === null ? {} : { item: objective.item }),
          // O que falta numa encomenda é o ITEM, e não o boneco:
          // "Ainda falta: 1 Mateus" foi o que a primeira versão
          // escreveu. E o que falta num saque é o CONTÊINER, que
          // não tem shortname para procurar no catálogo de itens.
          label:
            objective.kind === 'container'
              ? describeContainerSelectors(objective.targets ?? [])
              : this.#deps.service.nameOfTarget(objective.item ?? objective.target),
          need: objective.amount,
          have: attempt.progress[objective.seq] ?? 0,
        }));

      // A concluída entra mesmo sem objetivo de plugin: o que ela
      // leva é o ESTADO, e é dele que o balcão precisa.
      if (objectives.length > 0 || attempt.status === 'completed') {
        quests.push({
          pq: attempt.id,
          id: attempt.questId,
          status: attempt.status === 'completed' ? 'completed' : 'active',
          objectives,
        });
      }
    }

    // ####  O QUE ELE JÁ FEZ, E NÃO FAZ DE NOVO  ####
    //
    // Só as `once` resgatadas: elas nunca mais voltam, e o cartão
    // delas no balcão só servia para o jogador clicar e ouvir que
    // não pode. Cooldown e diária ficam de fora — ali o cartão
    // ainda informa, e é o clique que diz quando ela volta.
    //
    // A interseção mora aqui, e não numa consulta com JOIN, porque
    // o catálogo do servidor já está em memória neste ponto: o SQL
    // seria uma segunda régua para "o que é definitivo".
    const claimed = new Set(this.#deps.repository.claimedQuestIds(serverId, steamId));
    const done =
      claimed.size === 0
        ? []
        : this.#deps.repository
            .listForServer(serverId)
            .filter((quest) => quest.repeatMode === 'once' && claimed.has(quest.id))
            .map((quest) => quest.id);

    const payload: QuestAssignPayload = {
      contract: QUESTS_CONTRACT,
      quests,
      ...(done.length === 0 ? {} : { done }),
    };
    const key = `${serverId}:${steamId}`;
    // A digital cobre as duas listas: sem o `done` aqui, resgatar a
    // última missão de um NPC não reenviaria nada, e o cartão dela
    // ficaria na caixa até o próximo motivo de reenvio.
    const fingerprint = JSON.stringify({ quests, done });

    if (this.#assigned.get(key) === fingerprint) {
      return;
    }

    await rcon.send(buildAssignCommand(steamId, payload));
    this.#assigned.set(key, fingerprint);
  }

  /**
   * O plugin gritou que esqueceu.
   *
   * ####  ISTO NÃO É ZELO: É O BURACO QUE FECHA  ####
   *
   * MEDIDO neste projeto, e o `ui-sync.ts` já o documenta: um
   * `oxide.reload` esvazia o cache do plugin SEM derrubar o RCON —
   * para o agente, nada aconteceu, e ele não reenvia.
   *
   * Nas missões o custo é maior que no menu: o plugin perde o
   * catálogo E as atribuições, o cache DAQUI continua achando que
   * mandou, e nada é contado até o jogador aceitar uma missão nova.
   * Quem quebra o empate é este grito.
   *
   * @returns `true` quando a linha era o pedido.
   */
  handleLine(serverId: string, line: string): boolean {
    if (!line.includes(`${REQUEST_MARKER}${REQUEST_TOPIC}`)) {
      return false;
    }

    // Esquece TUDO daquele servidor: o catálogo e o que cada
    // jogador estava perseguindo. A rodada seguinte remonta.
    this.forget(serverId);

    for (const key of [...this.#assigned.keys()]) {
      if (key.startsWith(`${serverId}:`)) {
        this.#assigned.delete(key);
      }
    }

    // ####  OS NPCs TAMBEM SE PERDEM NO RELOAD  ####
    //
    // O plugin perde TUDO num `oxide.reload`, inclusive os bonecos
    // — mas o agente guarda a impressão digital do que mandou, e
    // sem esquecê-la ele nunca reenviaria. O mundo ficava sem NPC
    // nenhum até alguém editar um deles no painel, e foi
    // exatamente o que o teste de 12/09/2026 encontrou.
    //
    // O empurrão vai por um relógio: nenhum comando de RCON sai de
    // dentro do gancho que lê o console.
    this.#deps.npcs?.forget(serverId);

    const timer = setTimeout(() => {
      void this.#deps.npcs?.push(serverId).catch((error: unknown) => {
        this.#deps.logger.warn(
          { server: serverId, err: error },
          'os NPCs não voltaram depois do reload do plugin; a próxima volta tenta',
        );
      });
    }, 50);

    timer.unref();

    this.#deps.logger.info({ server: serverId }, 'o plugin esqueceu as missões; remontando');

    return true;
  }

  /**
   * O jogador acabou de entrar.
   *
   * ####  ELE NÃO PODE ESPERAR O CICLO  ####
   *
   * O relógio bate a cada 15 s, e o `flushSeconds` do servidor pode
   * ser bem maior. Quem conecta e vai direto minerar teria esse
   * tempo inteiro em que NADA conta — e é justamente o primeiro
   * minuto de jogo, quando ele está olhando se a missão funciona.
   *
   * Faz o mesmo trabalho da rodada, só que para ele: abre as
   * automáticas, recalcula os derivados e manda o `assign`.
   *
   * Não lança: isto roda no gancho de presença, e um jogador com
   * dado torto não pode derrubar a entrada dos outros.
   */
  async onPlayerJoined(serverId: string, steamIds: readonly string[]): Promise<void> {
    const rcon = this.#deps.servers.contextOf(serverId)?.rcon;

    if (rcon === undefined || !rcon.isConnected) {
      return;
    }

    if (!this.#deps.repository.settingsOf(serverId).enabled) {
      return;
    }

    for (const steamId of steamIds) {
      try {
        await this.#deps.service.autoAcceptFor({ serverId, steamId });
        this.#deps.service.refreshDerived({ serverId, steamId });
        await this.#pushAssign(serverId, steamId, rcon);
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, steamId, err: error },
          'não consegui preparar as missões de quem entrou; a rodada resolve',
        );
      }
    }
  }

  /**
   * Força o reenvio do `assign` daquele jogador.
   *
   * É o que o aceite e o cancelamento chamam: sem isto, o plugin só
   * saberia da missão nova na rodada seguinte — e o primeiro minuto
   * de jogo não contaria.
   */
  forgetPlayer(serverId: string, steamId: string): void {
    this.#assigned.delete(`${serverId}:${steamId}`);
  }
}
