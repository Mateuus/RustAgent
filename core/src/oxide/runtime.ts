// ============================================================
//  runtime.ts  -  o que o Oxide REALMENTE carregou.
//
//  ####  POR QUE ISTO PRECISA EXISTIR  ####
//
//  O acervo (library.ts) responde "o .cs está na pasta e ligado
//  neste servidor". Isso NÃO é a mesma pergunta que "o plugin
//  está rodando". Entre as duas cabe um plugin que não compila.
//
//  Aconteceu nesta máquina em 04/09/2026: um update do Rust
//  mudou `ItemContainer.CanAcceptItem`, o OrigemZAgent parou de
//  compilar e três plugins que dependem dele saíram do ar junto.
//  O agente continuou achando que o plugin estava ligado, mandou
//  `origemz.players`, e o console — que não reclama de comando
//  que não conhece — não respondeu NADA. A tela de Jogadores
//  mostrou "erro interno" por cinco segundos de timeout, e o
//  defeito real estava a um `oxide.plugins` de distância.
//
//  Este arquivo faz essa pergunta ao servidor.
//
//  ------------------------------------------------------------
//  ####  A CHAVE É O NOME DO ARQUIVO, NÃO O TÍTULO  ####
//
//  O Oxide lista o plugin carregado pelo TÍTULO ("Admin No Loot")
//  e o falho pelo nome do ARQUIVO ("OrigemZAgent"). Só o segundo
//  casa com o acervo, que é indexado por `AdminNoLoot.cs`. Por
//  isso a linha do carregado é lida pelo `- Arquivo.cs` do fim, e
//  não pelo texto entre aspas.
// ============================================================

import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

/** Um plugin, como o Oxide daquele servidor o vê agora. */
export interface OxidePluginRuntime {
  /** O nome do arquivo SEM o `.cs` — a chave que casa com o acervo. */
  readonly name: string;
  /** O nome bonito, entre aspas na listagem. `null` no que falhou. */
  readonly title: string | null;
  readonly version: string | null;
  readonly loaded: boolean;
  /**
   * O que o Oxide disse sobre o plugin que NÃO carregou.
   *
   * É a prosa dele, inteira: `Failed to compile: ... | Line: 1858`
   * ou `Missing dependencies: OrigemZAgent`. Guardada crua porque a
   * linha e a mensagem do compilador são o que resolve o problema —
   * resumir aqui jogaria fora justamente isso.
   */
  readonly failure: string | null;
}

export interface OxideRuntime {
  readonly plugins: readonly OxidePluginRuntime[];
  /** epoch ms. */
  readonly readAt: number;
}

/**
 * Uma linha de plugin CARREGADO:
 *
 *     01 "Admin No Loot" (0.1.3) by Dana (0.00s / 0 B) - AdminNoLoot.cs
 *
 * O `- Arquivo.cs` está ancorado no fim de propósito: título e
 * autor são texto livre e podem ter hífen no meio.
 */
const LOADED_LINE =
  /^\s*\d+\s+"(?<title>[^"]*)"\s+\((?<version>[^)]*)\)\s+by\s+.*\s-\s+(?<file>[^\s]+)\.cs\s*$/;

/**
 * Uma linha de plugin que NÃO carregou:
 *
 *     07 OrigemZAgent - Failed to compile: ... | Line: 1858, Pos: 30
 *     08 OrigemZPlayer - Missing dependencies: OrigemZAgent
 *
 * Sem aspas, sem versão, sem `.cs`: é assim que o Oxide distingue
 * os dois casos, e é por isso que a ordem das duas tentativas
 * importa menos do que parece — uma não casa o formato da outra.
 */
const FAILED_LINE = /^\s*\d+\s+(?<name>[A-Za-z0-9_.-]+)\s+-\s+(?<failure>\S.*)$/;

/**
 * Lê a resposta do `oxide.plugins`.
 *
 * O que não casar com nenhum dos dois formatos é IGNORADO — o
 * cabeçalho "Listing 10 plugins:" cai aqui, e uma linha nova que o
 * Oxide inventar amanhã também. Inventar um plugin a partir de
 * texto que não se reconhece seria pior que não ver o plugin.
 */
export function parseOxidePlugins(output: string): readonly OxidePluginRuntime[] {
  const plugins: OxidePluginRuntime[] = [];

  for (const line of output.split(/\r?\n/)) {
    const loaded = LOADED_LINE.exec(line);

    if (loaded?.groups !== undefined) {
      plugins.push({
        name: loaded.groups['file'] ?? '',
        title: loaded.groups['title'] ?? null,
        version: loaded.groups['version'] ?? null,
        loaded: true,
        failure: null,
      });
      continue;
    }

    const failed = FAILED_LINE.exec(line);

    if (failed?.groups !== undefined) {
      plugins.push({
        name: failed.groups['name'] ?? '',
        title: null,
        version: null,
        loaded: false,
        failure: (failed.groups['failure'] ?? '').trim(),
      });
    }
  }

  return plugins;
}

/**
 * Pergunta ao servidor quais plugins estão de pé.
 *
 * @throws quando o RCON não responde. Quem chama decide o que
 * fazer com isso — e a resposta certa costuma ser "nada": um
 * servidor parado não tem plugin carregado, e isso não é defeito.
 */
export async function readOxideRuntime(rcon: OpsRcon): Promise<OxideRuntime> {
  const output = await rcon.send('oxide.plugins');

  return { plugins: parseOxidePlugins(output), readAt: Date.now() };
}

// ------------------------------------------------------------
//  O relógio
// ------------------------------------------------------------

/** De quanto em quanto tempo conferir. */
export const DEFAULT_OXIDE_RUNTIME_INTERVAL_MS = 60_000;

export interface OxideRuntimeServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface OxideRuntimeMonitorDeps {
  readonly servers: OxideRuntimeServers;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/**
 * Pergunta ao Oxide de cada servidor quem está de pé, e guarda a
 * resposta para as telas.
 *
 * ####  POR QUE UM RELÓGIO, E NÃO SÓ SOB DEMANDA  ####
 *
 * O plugin não quebra quando alguém abre a aba Plugins: ele quebra
 * quando o Rust atualiza, de madrugada, e o agente sobe o servidor
 * de volta sem ninguém olhando. Foi assim em 04/09/2026 — e o
 * defeito só apareceu horas depois, na primeira vez que alguém
 * tentou ver quem estava online.
 *
 * O custo é um comando de console por servidor por minuto, que é
 * ruído nenhum perto de um plugin de loja fora do ar sem aviso.
 *
 * ####  A LEITURA NUNCA DERRUBA O RELÓGIO  ####
 *
 * Servidor parado, RCON caído, resposta estranha: tudo isso é
 * rotina aqui. Uma exceção que escapasse pararia a vigilância para
 * sempre, em silêncio — o pior jeito de um relógio falhar.
 */
export class OxideRuntimeMonitor {
  readonly #deps: OxideRuntimeMonitorDeps;
  readonly #intervalMs: number;

  /** id do servidor -> a última leitura boa. */
  readonly #state = new Map<string, OxideRuntime>();
  /**
   * id do servidor -> os plugins que já estavam falhando quando
   * olhamos da última vez.
   *
   * Existe só para o LOG: sem ele, um plugin que não compila
   * repetiria o mesmo aviso a cada minuto, e o log viraria uma
   * parede que ninguém lê. Avisar de novo quando a falha MUDA é o
   * comportamento certo — a mensagem do compilador é diferente
   * depois de uma correção pela metade.
   */
  readonly #announced = new Map<string, Map<string, string>>();

  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(deps: OxideRuntimeMonitorDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DEFAULT_OXIDE_RUNTIME_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    this.#timer.unref();

    this.#deps.logger.info(
      { intervalSeconds: Math.round(this.#intervalMs / 1000) },
      'relógio do estado dos plugins ligado',
    );

    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * O que sabemos AGORA, sem perguntar ao servidor.
   *
   * `null` = ninguém conseguiu ler ainda. A tela mostra isso como
   * "não sei", que é diferente de "está tudo bem" — e é por isso
   * que o campo é anulável em vez de uma lista vazia.
   */
  stateOf(serverId: string): OxideRuntime | null {
    return this.#state.get(serverId) ?? null;
  }

  /** O estado daquele plugin, pelo nome do arquivo sem `.cs`. */
  pluginOf(serverId: string, name: string): OxidePluginRuntime | null {
    return this.#state.get(serverId)?.plugins.find((plugin) => plugin.name === name) ?? null;
  }

  /**
   * Pergunta AGORA àquele servidor.
   *
   * `null` = não deu para perguntar (servidor parado, RCON fora).
   * A última leitura boa continua guardada: ela ainda é a melhor
   * resposta que existe, e apagá-la faria a tela esquecer o
   * problema justamente quando o servidor caiu por causa dele.
   */
  async refresh(serverId: string): Promise<OxideRuntime | null> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return null;
    }

    try {
      const runtime = await readOxideRuntime(context.rcon);

      this.#state.set(serverId, runtime);
      this.#announce(serverId, runtime);

      return runtime;
    } catch (error) {
      this.#deps.logger.debug(
        { err: toError(error), server: serverId },
        'não consegui ler o oxide.plugins deste servidor',
      );

      return null;
    }
  }

  /**
   * Relê aquele servidor SE a última leitura já estiver velha.
   *
   * ####  PARA QUE UMA VOLTA MAIS CURTA QUE A DO RELÓGIO  ####
   *
   * O relógio olha de minuto em minuto, e isso basta para
   * DESCOBRIR um plugin caído. Não basta para perceber que ele
   * VOLTOU: quem acabou de corrigir o `.cs` e recarregou fica até
   * um minuto vendo a tela dizer que está tudo errado — e o
   * primeiro instinto, justamente ali, é mexer de novo no que já
   * estava certo.
   *
   * Quem chama não espera (`void`): é a leitura SEGUINTE que
   * aproveita, e nada nesta depende do resultado.
   */
  refreshIfStale(serverId: string, maxAgeMs: number): void {
    const known = this.#state.get(serverId);

    if (known !== undefined && Date.now() - known.readAt < maxAgeMs) {
      return;
    }

    void this.refresh(serverId);
  }

  /** Uma passada por todos. Nunca lança. */
  async sweep(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      for (const id of this.#deps.servers.ids()) {
        await this.refresh(id);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Avisa no log o que passou a falhar desde a última olhada. */
  #announce(serverId: string, runtime: OxideRuntime): void {
    const antes = this.#announced.get(serverId) ?? new Map<string, string>();
    const agora = new Map<string, string>();

    for (const plugin of runtime.plugins) {
      if (plugin.failure === null) {
        continue;
      }

      agora.set(plugin.name, plugin.failure);

      if (antes.get(plugin.name) === plugin.failure) {
        continue;
      }

      this.#deps.logger.warn(
        { server: serverId, plugin: plugin.name, failure: plugin.failure },
        'plugin no lugar mas FORA DO AR — o Oxide não conseguiu carregá-lo',
      );
    }

    for (const [name] of antes) {
      if (!agora.has(name)) {
        this.#deps.logger.info({ server: serverId, plugin: name }, 'plugin voltou ao ar');
      }
    }

    this.#announced.set(serverId, agora);
  }
}
