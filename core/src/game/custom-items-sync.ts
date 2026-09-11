// ============================================================
//  custom-items-sync.ts  -  leva o CADASTRO de itens custom, e as
//  REGRAS DE LOOT que os soltam nas caixas, até o plugin.
//
//  ####  UM CANAL SÓ, E A ORDEM DENTRO DELE IMPORTA  ####
//
//  A regra de loot não é um cadastro independente: ela aponta para
//  um item custom, e é dele que sai a MARCA que o plugin carimba.
//  Por isso os dois viajam na MESMA rodada, e nesta ordem —
//  `item.clear`, os `item.set`, `loot.clear`, os `loot.set`.
//
//  Dois canais separados entregariam os dois fora de ordem no dia
//  em que um deles atrasasse, e a regra chegaria antes do item que
//  ela cita. O plugin recusaria a regra e ela ficaria fora até a
//  próxima sincronização — sem nada quebrar, e sem ninguém saber.
//
//  E há a consequência boa: uma regra cujo item NÃO foi aceito
//  pelo plugin nesta rodada não é mandada (ver `#pushLootRules`).
//  Só quem tem a lista dos dois na mão sabe disso.
//
//  ####  SEM ISTO, O ITEM CUSTOM NÃO EXISTE NO JOGO  ####
//
//  E era esse o buraco. O item ficava no banco, aparecia no painel
//  e até era entregue pelo `origemz.give` com a skin certa — mas o
//  plugin **nunca soube que ele existe**. Sem a marca cadastrada
//  lá, o `Match()` não acha nada: o nome não é aplicado, o ícone
//  não é aplicado, e a conversão em ponto não tem como acontecer.
//
//  Ver Docs\CustomItem\03-ACAO-PONTOS-DE-RANKING.md §6.
//
//  ------------------------------------------------------------
//  ####  POR QUE N COMANDOS, E NÃO UM PAYLOAD  ####
//
//  O loadout e o VIP mandam o estado inteiro num comando só, em
//  base64. Aqui não dá: cada item traz nome, descrição e uma ação
//  com lista de efeitos, e o conjunto passa do frame do RCON com
//  poucas dezenas de itens.
//
//  Então é `clear` seguido de um `set` por item — o mesmo desenho
//  que o plugin já expõe. O `clear` primeiro é o que faz um item
//  APAGADO no painel sumir do jogo: sem ele, o plugin guardaria
//  para sempre o que já não existe.
//
//  ####  E POR QUE O `clear` NÃO DEIXA UMA JANELA PERIGOSA  ####
//
//  Entre o `clear` e o último `set` o plugin fica sem marcas, e um
//  troféu que entre no inventário nesse instante não é reconhecido.
//  A janela é de milissegundos e o desfecho é benigno: o item
//  continua no inventário, sem nome, até a próxima sincronização —
//  e não some nem vira ponto errado.
//
//  O contrário (dar `set` em tudo e só então `clear`) não existe: o
//  `clear` apagaria o que acabou de chegar.
//
//  ####  O PLUGIN PEDE, E ESTE MÓDULO RESPONDE  ####
//
//  MEDIDO neste projeto, e custou um jogador nascendo sem nada: um
//  `oxide.reload` esvazia o cache do plugin sem derrubar o RCON —
//  para o agente, nada aconteceu. Daí o plugin gritar `#OZAREQ#`
//  quando esquece, e daí o `handleLine` aqui embaixo.
// ============================================================

import type {
  CustomItemAction,
  CustomItemRecord,
  CustomItemsRepository,
} from '../db/custom-items-repository.js';
import type { LootRuleRecord } from '../db/loot-rules-repository.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { disconnectedRcon } from '../ops/service.js';
import { toError } from '../util.js';
import {
  IMAGE_FAMILIES,
  imageAsset,
  type ImageAsset,
  type ImageLibrary,
} from './image-library.js';

/**
 * A chave do ícone de um item no OrigemZImages.
 *
 * PRECISA BATER COM `IconKeyPrefix` em Plugins/OrigemZItems.cs: é
 * por ela que o plugin pergunta o CRC na hora de vestir o item.
 */
export function itemIconKey(itemId: string): string {
  return `item.${itemId}`;
}

/** `origemz.item.clear` — o plugin esquece tudo antes de reaprender. */
export const CLEAR_COMMAND = 'origemz.item.clear';

/**
 * O `clear`, com o segredo que autentica os eventos de ponto.
 *
 * ####  POR QUE O SEGREDO PEGA CARONA AQUI  ####
 *
 * Ele não protege o cadastro — protege o caminho de VOLTA. O
 * `OrigemZItems` grita `#OZSTAT#{…}` no console quando converte um
 * item em ponto, e o agente lê TODA linha do console: sem um
 * segredo no payload, um jogador que digitasse o marcador no chat
 * concederia pontos a si mesmo (ver `rankings/stat-events.ts`).
 *
 * E ele viaja no `clear`, e não num comando próprio nem no `set`,
 * por três razões medidas neste arquivo:
 *
 *   1. o `clear` é o ÚNICO comando que sai sempre — inclusive num
 *      servidor sem item custom nenhum, onde não há `set` algum.
 *      Um servidor assim ficaria mudo para sempre;
 *   2. ele é o PRIMEIRO, então quando o primeiro `set` chega o
 *      plugin já sabe autenticar;
 *   3. um comando a mais seria uma ida e volta de RCON por
 *      sincronização para carregar 36 caracteres.
 *
 * `undefined` = sem segredo, e o comando sai como sempre saiu. O
 * plugin, nesse caso, SEGURA os eventos na fila em disco em vez de
 * emiti-los — nada se perde, e o `origemz.item.pending` os entrega.
 */
export function buildClearCommand(secret?: string): string {
  return secret === undefined || secret === '' ? CLEAR_COMMAND : `${CLEAR_COMMAND} ${secret}`;
}

/** `origemz.item.set <json>` — uma definição. */
export const SET_COMMAND = 'origemz.item.set';

/**
 * `origemz.loot.clear` — o plugin esquece as regras de loot.
 *
 * Ele sai SEMPRE, inclusive num servidor sem regra nenhuma: é isso
 * que faz uma regra apagada no painel parar de valer no jogo. Sem
 * ele, o plugin continuaria soltando o item até o próximo restart.
 *
 * ####  E ELE NÃO CARREGA SEGREDO  ####
 *
 * O segredo do `item.clear` protege o caminho de VOLTA dos pontos
 * (`#OZSTAT#`), que é onde alguém digitando um marcador no chat
 * poderia se premiar. A telemetria de loot não tem essa exposição:
 * ela é PERGUNTADA por RCON, e o que responde é o plugin — não há
 * linha de console que alguém possa forjar.
 */
export const LOOT_CLEAR_COMMAND = 'origemz.loot.clear';

/** `origemz.loot.set <json>` — uma regra. */
export const LOOT_SET_COMMAND = 'origemz.loot.set';

/** O marcador, sem o assunto. Ver `isRequestLine`. */
const REQUEST_MARKER = '#OZAREQ#';

/** O assunto que é NOSSO. O `OrigemZAgent` usa o mesmo marcador. */
const REQUEST_SUBJECT = 'items';

/**
 * A linha com que o plugin PEDE a lista de volta.
 *
 * O marcador é o mesmo do `OrigemZAgent` (`#OZAREQ#`), com o
 * assunto colado. Ver `Plugins/OrigemZItems.cs`, `RequestSync`.
 */
export const REQUEST_LINE = REQUEST_MARKER + REQUEST_SUBJECT;

/**
 * Junta em um envio só as edições em rajada.
 *
 * Salvar um item no painel é um POST/PUT por vez, mas o admin que
 * liga cinco itens num servidor faz cinco em poucos segundos — e
 * cada um custaria um `clear` + N `set` em cada servidor. O mesmo
 * número do `ui-sync`, pela mesma razão.
 */
const DEBOUNCE_MS = 250;

/**
 * A linha é o pedido do plugin?
 *
 * ####  IGUALDADE, E NÃO `includes`  ####
 *
 * O console devolve também os comandos que NÓS mandamos. Um item
 * cuja mensagem de chat contivesse `#OZAREQ#items` faria o eco do
 * nosso próprio `origemz.item.set` parecer um pedido — e aí o laço
 * do §11.6 se fecha sozinho, sem ninguém ter escrito nada errado.
 *
 * Exigir que o que vem DEPOIS do marcador seja exatamente `items`
 * fecha isso: no eco do comando ainda haveria o resto do JSON
 * atrás.
 */
export function isRequestLine(line: string): boolean {
  const at = line.indexOf(REQUEST_MARKER);

  if (at < 0) {
    return false;
  }

  return line.slice(at + REQUEST_MARKER.length).trim() === REQUEST_SUBJECT;
}

export interface CustomItemServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

/**
 * De onde sai o nome legível de um ranking.
 *
 * ####  O PLUGIN NÃO CONHECE O RÓTULO, E NÃO VAI PERGUNTAR  ####
 *
 * A ação `points` carrega a MÉTRICA (`trophy.bleik`), que é
 * protocolo. Quem guarda o nome que um jogador lê ("Troféu Bleik
 * Store") é a tabela `rankings`, do lado de cá — e a mensagem do
 * chat tem um marcador `{ranking}` que precisa dele.
 *
 * Mandá-lo junto da definição é o que evita uma ida e volta de
 * RCON no meio da conversão, que é o caminho onde o item já foi
 * destruído e o ponto ainda não chegou a lugar nenhum.
 *
 * Interface mínima de propósito: quem a satisfaz em produção é o
 * `RankingsRepository`, e um teste a satisfaz com um objeto
 * literal — a mesma escolha do `CustomItemServers` acima.
 */
export interface RankingLabels {
  /** `null` = não há ranking com essa métrica. */
  getByMetric(metric: string): { readonly label: string } | null;
}

/**
 * De onde saem as regras de loot daquele servidor.
 *
 * Interface mínima, como as duas acima: quem a satisfaz em produção
 * é o `LootRulesRepository`, e um teste a satisfaz com um objeto
 * literal.
 *
 * Ausente = este agente não tem regra de loot nenhuma para
 * empurrar, e a rodada continua exatamente como antes. É o que
 * mantém de pé o teste que monta o sync sem loot.
 */
export interface LootRuleSource {
  listForServer(serverId: string): readonly LootRuleRecord[];
}

export interface CustomItemsSyncDeps {
  readonly repository: CustomItemsRepository;
  readonly servers: CustomItemServers;
  /**
   * Quem sabe o nome legível de cada métrica.
   *
   * Ausente = o `{ranking}` da mensagem cai na métrica crua. Os
   * testes que não falam de mensagem o omitem. Ver `RankingLabels`.
   */
  readonly rankings?: RankingLabels;
  /**
   * As regras de loot daquele servidor.
   *
   * Ausente = nenhuma regra viaja, e a rodada é exatamente a de
   * antes — inclusive sem o `loot.clear`. É deliberado: um agente
   * que não gerencia loot não deve apagar as regras de um plugin
   * que talvez as tenha recebido de outra fonte.
   */
  readonly lootRules?: LootRuleSource;
  readonly logger: Logger;
  /**
   * O segredo que autentica o `#OZSTAT#` de volta.
   *
   * Ausente = o plugin não emite evento de ponto pelo console (ele
   * os segura na fila, e a varredura do `origemz.item.pending` os
   * recolhe). Ver `buildClearCommand`.
   *
   * É o MESMO valor que o `StatEventsConsumer` confere — os dois
   * recebem a dep do `index.ts`, de uma variável só. Dois sorteios
   * independentes fariam o agente descartar tudo o que o plugin
   * emitisse, e o sintoma seria "os pontos só chegam de cinco em
   * cinco minutos".
   */
  readonly secret?: string;
  /**
   * Os ícones dos itens, e quem os leva ao jogo.
   *
   * ####  SEM ISTO, O ÍCONE NUNCA SAÍA DO DISCO  ####
   *
   * O painel grava o PNG em `Assets\items\` e o nome em
   * `icon_file`; o plugin tinha comandos para recebê-lo. Faltava a
   * ponte: nada daqui lia o arquivo, e o item aparecia no jogo com
   * o ícone do item base.
   *
   * `read` recebe o `icon_file` e devolve os bytes, ou `null`.
   * Ausente = nenhum ícone viaja, e a rodada é a de antes — é o que
   * os testes que não falam de ícone usam.
   */
  readonly icons?: {
    readonly library: ImageLibrary;
    readonly read: (file: string) => Buffer | null;
  };
}

export interface CustomItemsSyncResult {
  readonly serverId: string;
  /** Quantas definições foram mandadas. */
  readonly sent: number;
  /** Quantas o plugin recusou (marca duplicada, item base sumido). */
  readonly refused: number;
  /** Quantas regras de loot foram mandadas. */
  readonly lootSent: number;
  /**
   * Quantas regras ficaram de fora.
   *
   * Duas causas, e as duas são benignas: o plugin recusou, ou o
   * ITEM da regra não entrou nesta rodada — e mandar uma regra que
   * cita um item que o plugin não tem produziria item sem marca.
   */
  readonly lootRefused: number;
  /** `null` = o envio aconteceu. Preenchido = por que não. */
  readonly skipped: string | null;
}

export class CustomItemsSync {
  readonly #deps: CustomItemsSyncDeps;

  /**
   * Quem já está sincronizando, para não sincronizar duas vezes.
   *
   * O plugin pode gritar `#OZAREQ#` no mesmo instante em que o RCON
   * reconecta, e as duas rodadas mandariam `clear` uma por cima da
   * outra — deixando o plugin com metade da lista.
   */
  readonly #running = new Set<string>();

  /**
   * Quem mudou ENQUANTO estava sincronizando.
   *
   * ####  SEM ISTO, UMA EDIÇÃO SOME  ####
   *
   * O `#running` sozinho recusa a segunda rodada — e a recusa é
   * silenciosa para quem salvou: o item ficou no banco, o painel
   * mostra certo, e o jogo continua com a lista de antes até a
   * próxima reconexão. A marca aqui faz a rodada em curso reiniciar
   * uma vez ao terminar, que é o que fecha a diferença.
   */
  readonly #dirty = new Set<string>();

  /** Os relógios do `invalidate`. Ver `DEBOUNCE_MS`. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: CustomItemsSyncDeps) {
    this.#deps = deps;
  }

  /**
   * Manda daqui a pouco, juntando as edições em rajada.
   *
   * É esta a porta de quem NÃO pode esperar o RCON: as rotas de
   * CRUD e o gancho de linha de console. Ela devolve na hora, e o
   * envio acontece fora do caminho de quem chamou — que é a regra
   * do §11.6, e a razão de o `handleLine` não chamar `push` direto.
   */
  invalidate(serverId: string, trigger: string): void {
    if (this.#timers.has(serverId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);

      void this.push(serverId, trigger).catch((error: unknown) => {
        // Não deveria acontecer: `push` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um timer, onde uma
        // Promise rejeitada não teria quem a pegasse.
        this.#deps.logger.error(
          { server: serverId, err: toError(error) },
          'o envio dos itens custom lançou',
        );
      });
    }, DEBOUNCE_MS);

    // Como todo relógio deste projeto: um envio pendente não pode
    // segurar o processo vivo no desligamento.
    timer.unref();
    this.#timers.set(serverId, timer);
  }

  /** O mesmo, em todos os servidores. É o que uma edição dispara. */
  invalidateAll(trigger: string): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.invalidate(serverId, trigger);
    }
  }

  /** Cancela o que ainda não saiu. Só o desligamento chama. */
  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
  }

  /**
   * Empurra o cadastro daquele servidor.
   *
   * NUNCA lança: quem salva um item no painel não tem o que fazer
   * com uma exceção vinda de um servidor que estava reiniciando, e
   * a linha já está no banco. O desfecho vai na resposta.
   */
  async push(serverId: string, trigger: string): Promise<CustomItemsSyncResult> {
    if (this.#running.has(serverId)) {
      // Ver `#dirty`: a rodada em curso repete quando terminar, e é
      // por isso que recusar aqui não perde a edição de quem chamou.
      this.#dirty.add(serverId);

      return {
        serverId,
        sent: 0,
        refused: 0,
        lootSent: 0,
        lootRefused: 0,
        skipped: 'já havia uma sincronização em curso',
      };
    }

    const rcon = this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);

    if (!rcon.isConnected) {
      // Não é erro: o servidor está parado, e o cadastro sobe
      // sozinho quando ele voltar — é o gancho `rcon-connected`.
      return {
        serverId,
        sent: 0,
        refused: 0,
        lootSent: 0,
        lootRefused: 0,
        skipped: 'o RCON está fora do ar',
      };
    }

    this.#running.add(serverId);

    try {
      const items = this.#deps.repository.listForServer(serverId);

      // ####  OS ÍCONES VÊM ANTES DO CADASTRO  ####
      //
      // Pela mesma razão das imagens do menu virem antes dos
      // documentos: quando o `set` chegar e o plugin vestir o item, o
      // CRC precisa já estar no OrigemZImages. Falha aqui não segura a
      // rodada — item sem ícone próprio continua sendo o item.
      await this.#pushIcons(serverId, rcon, items);

      // O segredo do caminho de volta vai junto — ver
      // `buildClearCommand`.
      const cleared = await rcon.send(buildClearCommand(this.#deps.secret));

      // O `clear` que não respondeu é quase sempre plugin que não
      // carregou — e aí os `set` abaixo também não vão colar. Os
      // `set` saem assim mesmo (lista parcial é melhor que lista
      // nenhuma), mas o motivo fica no log: sem esta linha, o
      // sintoma seria "o agente diz que mandou e o jogo não sabe".
      if (!cleared.includes('"ok":true')) {
        this.#deps.logger.warn(
          { server: serverId, trigger, response: cleared.slice(0, 200) },
          'o plugin não confirmou o esquecimento da lista; ele está carregado neste servidor?',
        );
      }

      let sent = 0;
      let refused = 0;

      // ####  QUEM ENTROU DE VERDADE, E NÃO QUEM FOI LISTADO  ####
      //
      // É este conjunto que decide quais regras de loot podem
      // viajar. Uma regra que cite um item recusado pelo plugin
      // criaria, no jogo, um `discord.trophy` de skin nenhuma — sem
      // nome, sem ação, e que o jogador lê como lixo. Ver
      // Docs/CustomItem/04 §4.3.
      const sentIds = new Set<string>();

      for (const item of items) {
        // Item cujo base sumiu do jogo não é mandado: o plugin o
        // recusaria com UNKNOWN_BASE_ITEM, e uma recusa esperada
        // vira ruído no log que ensina a ignorar o log.
        if (item.baseMissing) {
          this.#deps.logger.warn(
            { server: serverId, item: item.id, base: item.baseShortname },
            'item custom não sincronizado: o jogo não tem mais o item base',
          );
          refused += 1;
          continue;
        }

        const response = await rcon.send(
          `${SET_COMMAND} ${JSON.stringify(toPluginBody(item, this.#rankingLabel(item)))}`,
        );

        if (response.includes('"ok":true')) {
          sent += 1;
          sentIds.add(item.id);
        } else {
          refused += 1;
          this.#deps.logger.warn(
            { server: serverId, item: item.id, response: response.slice(0, 200) },
            'o plugin recusou uma definição de item custom',
          );
        }
      }

      // ####  AS REGRAS VÊM DEPOIS DOS ITENS, E NÃO É DETALHE  ####
      //
      // A regra cita um item pelo id, e o plugin resolve a marca no
      // cadastro que acabou de receber. Mandá-la antes seria mandar
      // uma referência para o que ainda não chegou.
      const loot = await this.#pushLootRules(serverId, trigger, rcon, sentIds);

      this.#deps.logger.info(
        { server: serverId, sent, refused, lootSent: loot.sent, lootRefused: loot.refused, trigger },
        'itens custom empurrados ao plugin',
      );

      return { serverId, sent, refused, lootSent: loot.sent, lootRefused: loot.refused, skipped: null };
    } catch (error) {
      const reason = toError(error).message;

      this.#deps.logger.warn(
        { server: serverId, trigger, err: toError(error) },
        'não consegui empurrar os itens custom',
      );

      return { serverId, sent: 0, refused: 0, lootSent: 0, lootRefused: 0, skipped: reason };
    } finally {
      this.#running.delete(serverId);

      // Alguém salvou no meio desta rodada. Repete — pelo caminho do
      // relógio, e não recursivamente: uma edição a cada rodada
      // manteria a pilha crescendo, e o debounce junta as que
      // vierem em seguida.
      if (this.#dirty.delete(serverId)) {
        this.invalidate(serverId, 'mudou-durante-a-sincronização');
      }
    }
  }

  /**
   * Todos os servidores. É o que roda no boot.
   *
   * Um servidor que falha não segura os outros: o motivo dele já
   * vai no `skipped` do resultado.
   */
  async pushAll(trigger: string): Promise<readonly CustomItemsSyncResult[]> {
    const results: CustomItemsSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.push(serverId, trigger));
    }

    return results;
  }

  /**
   * O plugin pediu a lista de volta?
   *
   * ####  ELE RECUSA EM UMA COMPARAÇÃO DE STRING  ####
   *
   * Este método é chamado para TODA linha do console — centenas por
   * minuto num servidor cheio. Tudo o que não é o pedido sai daqui
   * na primeira comparação, e nada mais acontece.
   *
   * ####  E A RESPOSTA SAI FORA DESTE CAMINHO  ####
   *
   * Quem responde é o `invalidate`, que só arma um relógio: nenhum
   * comando de RCON sai da pilha deste gancho. Mandar daqui é o
   * laço que já aconteceu neste projeto — o comando imprime, a
   * linha volta por aqui, e dispara de novo. Ver `core/src/index.ts`
   * e Docs\CustomItem\03 §11.6.
   */
  /**
   * O nome legível do ranking daquele item, se houver.
   *
   * `undefined` em três casos, e os três são o mesmo desfecho: o
   * campo não viaja e o `{ranking}` da mensagem cai na métrica.
   * Um ranking apagado depois do cadastro cai aqui — e isso não
   * pode impedir a definição de chegar ao jogo, porque a
   * identidade do item (nome, ícone) não depende do ranking.
   */
  /**
   * As regras de loot daquele servidor, depois dos itens.
   *
   * ####  ELE NUNCA LANÇA POR CAUSA DE UMA REGRA  ####
   *
   * O `try` está no `push`, um nível acima, e é ele que cobre a
   * queda do RCON. O que este método garante é o outro lado: um
   * servidor SEM regras ainda recebe o `loot.clear`, que é o único
   * comando capaz de fazer uma regra apagada parar de valer no
   * jogo.
   *
   * @param sentIds os itens que o plugin aceitou nesta rodada.
   */
  async #pushLootRules(
    serverId: string,
    trigger: string,
    rcon: OpsRcon,
    sentIds: ReadonlySet<string>,
  ): Promise<{ readonly sent: number; readonly refused: number }> {
    const source = this.#deps.lootRules;

    if (source === undefined) {
      return { sent: 0, refused: 0 };
    }

    const rules = source.listForServer(serverId);

    const cleared = await rcon.send(LOOT_CLEAR_COMMAND);

    // Plugin velho, que ainda não conhece o comando, responde
    // "Command not found" — e o servidor segue funcionando com os
    // itens custom, só sem regra de loot. Um `warn` é o certo: não
    // é erro daqui, mas quem procurar "por que a medição não anda"
    // precisa achar esta linha.
    if (!cleared.includes('"ok":true')) {
      this.#deps.logger.warn(
        { server: serverId, trigger, response: cleared.slice(0, 200) },
        'o plugin não confirmou o esquecimento das regras de loot; ele está atualizado ali?',
      );
    }

    let sent = 0;
    let refused = 0;

    for (const rule of rules) {
      // O item não entrou nesta rodada (base sumido do jogo, marca
      // duplicada, plugin recusou). Mandar a regra assim mesmo
      // faria nascer item sem marca — ver `sentIds`.
      if (!sentIds.has(rule.customItemId)) {
        this.#deps.logger.warn(
          { server: serverId, rule: rule.id, item: rule.customItemId },
          'regra de loot não sincronizada: o item custom dela não chegou ao plugin',
        );
        refused += 1;
        continue;
      }

      const response = await rcon.send(
        `${LOOT_SET_COMMAND} ${JSON.stringify(toLootPluginBody(rule))}`,
      );

      if (response.includes('"ok":true')) {
        sent += 1;
      } else {
        refused += 1;
        this.#deps.logger.warn(
          { server: serverId, rule: rule.id, response: response.slice(0, 200) },
          'o plugin recusou uma regra de loot',
        );
      }
    }

    return { sent, refused };
  }

  /**
   * Garante que o OrigemZImages tem o ícone de cada item. NUNCA lança:
   * a biblioteca traduz falha em desfecho e registra o que faltou.
   *
   * Lê o disco a cada rodada, e é barato: a rodada acontece no boot,
   * na reconexão e a cada edição — não num relógio — e o manifesto
   * do plugin garante que o ícone que não mudou não sobe.
   */
  async #pushIcons(
    serverId: string,
    rcon: OpsRcon,
    items: readonly CustomItemRecord[],
  ): Promise<void> {
    const icons = this.#deps.icons;

    if (icons === undefined) {
      return;
    }

    const assets: ImageAsset[] = [];

    for (const item of items) {
      // Sem arquivo é o padrão BOM: o ícone do item base, que o
      // jogador já reconhece. E item cujo base sumiu nem vai ao
      // plugin, então o ícone dele não teria em quem aparecer.
      if (item.iconFile === null || item.baseMissing) {
        continue;
      }

      const bytes = icons.read(item.iconFile);

      if (bytes === null) {
        this.#deps.logger.warn(
          { server: serverId, item: item.id, icon: item.iconFile },
          'o ícone do item custom não está em Assets\\items; ele fica com o ícone do item base',
        );
        continue;
      }

      assets.push(imageAsset(itemIconKey(item.id), bytes));
    }

    // ####  O ÍCONE TIRADO PRECISA SAIR DO JOGO  ####
    //
    // A tabela do OrigemZImages sobrevive a reload e a restart, e o
    // plugin veste o item com o que achar lá. Sem a poda, um ícone
    // removido no painel (ou o de um item apagado) continuaria
    // aparecendo para sempre. A família `item.` é só nossa.
    await icons.library.sync(serverId, rcon, assets, { owns: IMAGE_FAMILIES.item });
  }

  #rankingLabel(item: CustomItemRecord): string | undefined {
    const metric = item.action.kind === 'points' ? item.action.metric : undefined;

    if (metric === undefined || metric === '' || this.#deps.rankings === undefined) {
      return undefined;
    }

    return this.#deps.rankings.getByMetric(metric)?.label;
  }

  handleLine(serverId: string, line: string): void {
    if (!isRequestLine(line)) {
      return;
    }

    this.#deps.logger.info(
      { server: serverId },
      'o plugin pediu os itens custom de volta (esqueceu no reload)',
    );

    this.invalidate(serverId, 'plugin-pediu');
  }
}

/**
 * Uma definição, na forma que o plugin entende.
 *
 * ####  OS DOIS LADOS MUDAM JUNTOS  ####
 *
 * O `ParseItem` do `OrigemZItems.cs` lê exatamente estes nomes.
 * Acrescentar campo aqui sem acrescentar lá faz o campo ser
 * ignorado em silêncio — que é o pior desfecho, porque a tela do
 * painel mostra a configuração e o jogo não a obedece.
 */
export function toPluginBody(
  item: CustomItemRecord,
  rankingLabel?: string,
): Record<string, unknown> {
  return {
    id: item.id,
    name: item.displayName,
    base: item.baseShortname,
    skin: item.skinId,
    deployable: item.deployable,
    // A COLUNA manda sobre o `action.onPickup`, que continua sendo
    // aceito no cadastro por compatibilidade. A pergunta "quando" é
    // do item, e não de cada tipo de ação — ver a migração 042 e
    // Docs\CustomItem\03 §3.2. O `onPickup` NÃO viaja: o
    // `ParseAction` do plugin nem o lê, e mandá-lo faria parecer
    // que ele é obedecido lá.
    consumeOnPickup: item.consumeOnPickup,
    // ####  CAMPO NULO É CAMPO OMITIDO, E ISSO FOI MEDIDO  ####
    //
    // 05/09/2026, no servidor de teste:
    //
    //     origemz.item.set {…,"maxStack":null}
    //     System.ArgumentException: Can not convert Null to Int32
    //
    // `body["maxStack"]` de um JSON com `null` devolve um JValue de
    // tipo Null — que passa no `!= null` do C# e estoura no cast. E
    // `max_stack` é nulo na MAIORIA dos cadastros ("herda o do item
    // base" é o padrão), então mandar o nulo recusava quase todo
    // item com INTERNAL_ERROR.
    //
    // O plugin passou a tolerar o nulo (ver `Missing`, no
    // OrigemZItems.cs), mas o agente não manda mais: os dois lados
    // mudaram juntos, e o campo que não tem valor não ocupa a
    // linha. `JSON.stringify` descarta `undefined` sozinho.
    description: item.description ?? undefined,
    message: item.message ?? undefined,
    maxStack: item.maxStack ?? undefined,
    // O ícone NÃO vai aqui: ele são bytes, viaja ao OrigemZImages
    // com a chave `itemIconKey(id)` (ver `#pushIcons`) e o
    // `ParseItem` não lê campo nenhum de ícone. Mandar o nome do
    // arquivo seria inventar um contrato que o outro lado não tem.
    action: toActionBody(item.action, rankingLabel),
  };
}

/**
 * Uma regra de loot, na forma que o plugin entende.
 *
 * ####  A MARCA VIAJA INTEIRA, E É POR ISSO QUE ELA VAI AQUI  ####
 *
 * `base` e `skin` saem do item custom e viajam DENTRO da regra —
 * ainda que o plugin já os tenha no cadastro do item. Não é
 * duplicação por descuido: é o que permite ao `OnLootSpawn` criar o
 * item sem uma segunda consulta no caminho quente, que dispara
 * milhares de vezes por dia (medido: 71 dos 105 containers têm
 * refresh de 1 a 2 h, `Docs/CustomItem/05` §2.6).
 *
 * E é a única coisa que faz o item ser o NOSSO: a tabela de loot do
 * Rust cria tudo com `skin = 0`, e o `Match` do plugin sai em
 * `item.skin == 0UL`. Ver `Docs/CustomItem/04` §4.
 *
 * ####  OS DOIS LADOS MUDAM JUNTOS  ####
 *
 * O `ParseLootRule` do `OrigemZItems.cs` lê exatamente estes nomes.
 * Acrescentar campo aqui sem acrescentar lá faz o campo ser
 * ignorado em silêncio — a tela mostra a configuração e o jogo não
 * a obedece.
 */
export function toLootPluginBody(rule: LootRuleRecord): Record<string, unknown> {
  return {
    id: rule.id,
    item: rule.customItemId,
    // Ver o cabeçalho desta função.
    base: rule.itemBaseShortname ?? undefined,
    skin: rule.itemSkinId ?? undefined,
    containers: rule.containers,
    chance: rule.chance,
    amountMin: rule.amountMin,
    amountMax: rule.amountMax,
    // O campo que decide se sai item ou só conta. Ele viaja SEMPRE:
    // um plugin que não o receba não teria como saber, e o default
    // dele é o que solta item no mundo.
    mode: rule.mode,
    // ####  CAMPO NULO É CAMPO OMITIDO  ####
    //
    // MEDIDO em 05/09/2026: `"maxStack":null` estourava o
    // `ParseItem` com "Can not convert Null to Int32". O plugin
    // passou a tolerar o nulo (ver `Missing`), mas o agente não o
    // manda — e `dailyCap`/`playerCooldownHours` são nulos na
    // maioria das regras. `JSON.stringify` descarta `undefined`.
    dailyCap: rule.dailyCap ?? undefined,
    playerCooldownHours: rule.playerCooldownHours ?? undefined,
  };
}

/**
 * A ação, com os campos que o plugin de fato lê.
 *
 * ####  A COLUNA `action` É JSON LIVRE; ESTA FUNÇÃO NÃO É  ####
 *
 * Repassar a coluna inteira faria qualquer campo gravado ali
 * atravessar para o jogo — inclusive os que o `ParseAction` ignora,
 * como o `onPickup`. Uma lista explícita é o que torna visível, na
 * revisão, que acrescentar campo aqui obriga a acrescentar lá.
 */
function toActionBody(
  action: CustomItemAction,
  rankingLabel?: string,
): Record<string, unknown> {
  return {
    kind: action.kind,
    // ---- `consume` ----
    trigger: action.trigger,
    consumes: action.consumes,
    effects: action.effects,
    // ---- `points` ----
    //
    // A métrica é o PROTOCOLO: é ela que vai no evento e é por ela
    // que o agente acha o ranking. Ela viaja sempre.
    metric: action.metric,
    perUnit: action.perUnit,
    // ####  E O RÓTULO VIAJA PORQUE O JOGADOR LÊ  ####
    //
    // O `{ranking}` da mensagem do chat precisa de "Troféu Bleik
    // Store", e não de `trophy.bleik`. O plugin não tem a tabela
    // `rankings` — ele recebe o nome pronto e o substitui.
    //
    // `undefined` some do JSON, e o plugin cai na métrica: um
    // cadastro empurrado por um agente anterior a este campo
    // continua funcionando, com uma mensagem menos bonita. Ver
    // `RankingLabels`.
    ranking: rankingLabel,
  };
}
