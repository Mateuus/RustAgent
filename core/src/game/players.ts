// ============================================================
//  players.ts  -  quem está online, agora.
//
//  Duas fontes, e a escolha entre elas NÃO é do operador:
//
//    origemz.players   com o OrigemZAgent ligado naquele servidor.
//                      Dá posição, vivo/dormindo, vida, ping e
//                      tempo de conexão
//    playerlist        o nativo do Rust. Dá SteamID, nome, ping,
//                      tempo e vida — e nada de posição
//
//  O agente sabe se o plugin está ligado ali (o acervo responde
//  isso) e usa o que há. A tela DIZ qual fonte está em uso e
//  oferece ligar o plugin quando ele estiver disponível e
//  desligado — mas ninguém precisa escolher uma fonte para ver a
//  lista.
//
//  ------------------------------------------------------------
//  ####  RESPOSTA FORA DO CONTRATO O AGENTE RECUSA  ####
//
//  O plugin promete um JSON de uma linha. Vindo outra coisa, isto
//  aqui levanta `PLUGIN_INVALID_RESPONSE` — e não um `catch`
//  silencioso que devolve lista vazia.
//
//  "Zero jogadores" e "não consegui perguntar" são respostas
//  diferentes, e a segunda não pode se disfarçar da primeira: um
//  servidor cheio apareceria vazio, e ninguém iria procurar
//  defeito num número que parece plausível.
//
//  ####  O QUE FALTA É DITO, E NÃO INVENTADO  ####
//
//  Sem o plugin, `position`, `isAlive` e `isSleeping` vêm `null` —
//  nunca `0` nem `false`. Ver Docs\07-PAINEL.md: ausente vira
//  travessão, e um "vivo" inventado é pior que um campo vazio.
//
//  ####  E A FALTA ANDA NOS DOIS SENTIDOS  ####
//
//  O `playerlist` nativo traz uma coisa que o plugin não tem: o
//  ENDEREÇO do jogador. É de lá que sai o `last_ip` da tabela de
//  jogadores — e é por isso que aquela coluna é anulável. Num
//  servidor com o OrigemZAgent ligado ela simplesmente não é
//  preenchida, e isso é melhor que um IP adivinhado.
// ============================================================

import { sanitizeArgument } from '../bans/rust-bans.js';
import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';
import { RconError } from '../rcon/errors.js';
import { gridLabel, worldGrid, type WorldGrid } from './grid.js';
import {
  buildGiveCommand,
  buildPlayersCommand,
  buildTeleportCommand,
  describeGiveError,
  firstJsonLine,
  giveResponseSchema,
  PLAYER_ACTIONS_PLUGIN,
  PLAYERS_DEFAULT_LIMIT,
  PLAYERS_PLUGIN,
  PLUGIN_COMMANDS,
  playersResponseSchema,
  teleportResponseSchema,
  type GiveMode,
  type Position,
} from './plugin-contract.js';

/** Um jogador, venha ele de onde vier. */
export interface PlayerView {
  readonly steamId: string;
  readonly name: string;
  /** `null` = a fonte atual não sabe. Ver o cabeçalho. */
  readonly health: number | null;
  readonly isAlive: boolean | null;
  readonly isSleeping: boolean | null;
  readonly ping: number | null;
  readonly connectedSeconds: number | null;
  readonly position: Position | null;
  /**
   * A célula do mapa: `G12`.
   *
   * Calculada AQUI, e não na tela, por dois motivos: a constante da
   * grade tem um dono só (game/grid.ts), e é assim que a lista de
   * jogadores mostra "onde ele está" numa coluna — `G12` responde a
   * pergunta que `(120.5, -840.2)` obriga a traduzir.
   *
   * `null` sem posição, ou seja, sempre que a fonte for o
   * `playerlist` nativo.
   */
  readonly grid: string | null;
  /**
   * O endereço de onde ele está jogando, sem a porta.
   *
   * Só a fonte NATIVA traz (`playerlist` responde
   * `"Address": "203.0.113.10:53248"`); com o plugin é `null`. É o
   * que alimenta `players.last_ip` — ver a migração 006.
   */
  readonly ip: string | null;
}

/** O estado de um plugin no acervo daquele servidor. */
export interface PluginState {
  /** `null` = ele nem está no acervo daquele servidor. */
  readonly id: number | null;
  readonly enabled: boolean;
}

/**
 * O que o leitor precisa saber sobre plugins.
 *
 * Interface mínima, e de propósito: quem a satisfaz em produção é
 * o `PluginLibrary` (pelo `serverList`), e um teste a satisfaz com
 * uma função. Ler a tabela `plugins` daqui seria um segundo
 * caminho para a mesma pergunta — e o segundo é o que diverge no
 * primeiro ajuste.
 */
export interface PluginPresence {
  stateOf(serverId: string, pluginName: string): Promise<PluginState>;
}

export interface PlayersSnapshot {
  /** De onde vieram os dados desta lista. */
  readonly source: 'plugin' | 'nativo';
  /** Quantos estão conectados no total. */
  readonly total: number;
  readonly players: readonly PlayerView[];
  /**
   * O tamanho do mundo e a grade dele.
   *
   * Vai junto porque é o que o Map View precisa para desenhar: a
   * projeção depende do `size`, e as letras/números das células
   * dependem do `cellSize`. Mandá-los daqui é o que impede a
   * constante da grade de existir uma segunda vez no navegador —
   * e de as duas divergirem no dia em que o jogo mudar a dela.
   */
  readonly world: WorldGrid;
  /**
   * O plugin que daria a posição, e o estado dele aqui.
   *
   * É o que permite a tela oferecer "ligar" em vez de só informar
   * que a posição não está disponível. `id` nulo = ele não está no
   * acervo deste servidor, e aí o caminho é a aba Plugins.
   */
  readonly plugin: {
    readonly name: string;
    readonly id: number | null;
    readonly enabled: boolean;
    /**
     * Por que a lista NÃO veio do plugin, mesmo ele ligado.
     *
     * `null` = veio dele, ou ele está desligado — e aí `enabled`
     * já conta a história inteira.
     *
     * ####  DUAS FALHAS QUE SE PARECEM E NÃO SÃO A MESMA  ####
     *
     * `not-loaded`  o Oxide CONFIRMOU que não carregou o plugin.
     *               O arquivo está na pasta e não compila — foi o
     *               que aconteceu em 04/09/2026, depois de um
     *               update do Rust mudar a assinatura de
     *               `ItemContainer.CanAcceptItem`. Isso não passa
     *               sozinho: alguém precisa corrigir o `.cs`.
     *
     * `no-answer`   o comando saiu e a resposta não voltou a
     *               tempo, com o plugin de pé (ou sem dar para
     *               confirmar). É o servidor ocupado — comum nos
     *               primeiros minutos depois de subir, quando o
     *               console leva segundos para responder qualquer
     *               coisa. Isso passa sozinho.
     *
     * Confundir os dois é o defeito caro: mandar consertar um
     * plugin que está ótimo gasta a atenção que o alarme
     * verdadeiro precisa ter.
     */
    readonly fallback: 'not-loaded' | 'no-answer' | null;
  };
  /**
   * Os campos que a fonte atual NÃO fornece.
   *
   * A tela usa para explicar o travessão antes de alguém concluir
   * que o dado sumiu.
   */
  readonly missing: readonly string[];
}

/** Quanto tempo a resposta do acervo vale. */
const PLUGIN_STATE_TTL_MS = 5_000;

/**
 * Com o plugin dado como fora do ar, de quanto em quanto tempo
 * conferir se ele voltou.
 *
 * Mais curto que a volta do relógio (60 s) porque a pergunta aqui
 * é outra: o relógio existe para DESCOBRIR a queda, e este número
 * para perceber a VOLTA — que acontece logo depois de alguém
 * consertar o `.cs`, olhando a tela.
 */
const RUNTIME_MAX_AGE_MS = 10_000;

/** Teto de páginas por consulta. 500 × 10 = 5000 jogadores. */
const MAX_PAGES = 10;

/**
 * Quem sabe se o Oxide carregou aquele plugin.
 *
 * Interface mínima, satisfeita por estrutura pelo
 * `OxideRuntimeMonitor`. Opcional no reader: sem ela a queda para
 * o nativo continua acontecendo, só que sem conseguir dizer qual
 * das duas falhas foi — e o motivo mais fraco é o que se assume.
 */
export interface PlayersPluginRuntime {
  pluginOf(serverId: string, name: string): { readonly loaded: boolean } | null;
  refresh(serverId: string): Promise<unknown>;
  refreshIfStale(serverId: string, maxAgeMs: number): void;
}

export interface PlayersReaderDeps {
  readonly plugins: PluginPresence;
  readonly runtime?: PlayersPluginRuntime | undefined;
}

export class PlayersReader {
  readonly #plugins: PluginPresence;
  readonly #runtime: PlayersPluginRuntime | undefined;
  /** id -> o último estado lido do acervo, com a hora. */
  readonly #cache = new Map<string, { at: number; state: PluginState }>();

  constructor(deps: PlayersReaderDeps) {
    this.#plugins = deps.plugins;
    this.#runtime = deps.runtime;
  }

  /**
   * A lista de quem está online.
   *
   * `worldSize` vem do `.ini` daquele servidor e serve à grade: sem
   * ele não há como dizer em que célula do mapa alguém está, e o
   * Map View não teria como projetar nada.
   *
   * @throws {ApiError} 503 sem RCON, 502 quando o plugin responde
   * fora do contrato.
   */
  async list(serverId: string, rcon: OpsRcon, worldSize: number): Promise<PlayersSnapshot> {
    assertConnected(serverId, rcon);

    const plugin = await this.#stateOf(serverId);
    const world = worldGrid(worldSize);

    if (!plugin.enabled) {
      const read = await readNative(rcon);

      return { ...read, world, plugin: { name: PLAYERS_PLUGIN, ...plugin, fallback: null } };
    }

    // ####  NÃO BATER NUMA PORTA QUE SE SABE FECHADA  ####
    //
    // Se o Oxide JÁ disse que não carregou este plugin, mandar o
    // comando é comprar 5 s de timeout — e não é uma vez: esta
    // lista é relida a cada poucos segundos pela tela e a cada 15 s
    // pelo relógio da presença. Medido nesta máquina com o plugin
    // fora do ar, uma única leitura chegou a 20 s, porque o RCON
    // serializa um comando por vez e as chamadas entraram na fila
    // umas das outras. O console inteiro fica lento — o Console, as
    // operações, tudo passa por ali.
    //
    // Aqui a resposta sai do CACHE do relógio, que já custou o
    // comando dele. Quando o plugin voltar, a leitura seguinte do
    // relógio derruba este atalho sozinha.
    if (this.#runtime?.pluginOf(serverId, PLAYERS_PLUGIN)?.loaded === false) {
      // E confere de novo, em segundo plano, se a última olhada já
      // está velha: sem isto, quem acabou de consertar o plugin
      // ficaria até um minuto — a volta do relógio — vendo a tela
      // insistir que ele está fora do ar. É o momento exato em que
      // alguém mexe de novo no que já estava certo.
      this.#runtime.refreshIfStale(serverId, RUNTIME_MAX_AGE_MS);

      const read = await readNative(rcon);

      return { ...read, world, plugin: { name: PLAYERS_PLUGIN, ...plugin, fallback: 'not-loaded' } };
    }

    // ####  O PLUGIN LIGADO QUE NÃO RESPONDE  ####
    //
    // Ligado é sobre o ARQUIVO estar na pasta; respondendo é sobre
    // o Oxide o ter carregado. Entre os dois cabe um plugin que não
    // compila — e aí `origemz.players` não existe no console, que
    // não reclama: ele se cala até o timeout.
    //
    // Antes disto, a aba Jogadores inteira morria nesse silêncio.
    // O `playerlist` nativo continua ali, sabe quem está online, e
    // é o que sustenta expulsar e banir enquanto o plugin não
    // volta. O que ele não sabe — posição, vivo, dormindo — sai em
    // `missing`, e o `silent` abaixo diz POR QUE a fonte mudou.
    const fromPlugin = await readFromPlugin(rcon, world);

    if (fromPlugin !== null) {
      return { ...fromPlugin, world, plugin: { name: PLAYERS_PLUGIN, ...plugin, fallback: null } };
    }

    const read = await readNative(rcon);

    return {
      ...read,
      world,
      plugin: { name: PLAYERS_PLUGIN, ...plugin, fallback: await this.#whyNoAnswer(serverId) },
    };
  }

  /**
   * O plugin está fora do ar, ou só demorou?
   *
   * ####  POR QUE PERGUNTAR DE NOVO, JUSTO AGORA  ####
   *
   * Porque as duas causas pedem coisas opostas — uma pede conserto
   * no `.cs`, a outra pede esperar — e porque a diferença entre
   * elas se mede com um comando de console.
   *
   * O alarme errado aqui sai caro nos dois sentidos. Um servidor
   * que acabou de subir leva segundos para responder qualquer
   * coisa: nos primeiros minutos o `origemz.players` estoura os 5 s
   * do timeout com o plugin perfeitamente de pé. Dizer "não
   * carregou" ali mandaria consertar o que não está quebrado — e
   * um alarme desses, repetido depois de todo boot, ensina a
   * ignorar o alarme que importa.
   *
   * `no-answer` é o palpite quando não dá para confirmar: é o mais
   * fraco dos dois, e o que não acusa ninguém sem prova.
   */
  async #whyNoAnswer(serverId: string): Promise<'not-loaded' | 'no-answer'> {
    if (this.#runtime === undefined) {
      return 'no-answer';
    }

    // Sob demanda, e não pelo cache do relógio: a leitura de um
    // minuto atrás pode ser de antes de o plugin cair.
    await this.#runtime.refresh(serverId);

    return this.#runtime.pluginOf(serverId, PLAYERS_PLUGIN)?.loaded === false
      ? 'not-loaded'
      : 'no-answer';
  }

  /**
   * O estado do plugin naquele servidor, com cache curto.
   *
   * O acervo varre pastas para responder (ele ADOTA o `.cs` que
   * alguém copiou à mão), e a tela de jogadores atualiza a cada
   * poucos segundos. Sem o cache, cada volta do polling faria um
   * `readdir` por servidor — trabalho de disco para uma resposta
   * que muda quando alguém clica em "Ligar", e não a cada segundo.
   */
  async #stateOf(serverId: string): Promise<PluginState> {
    const cached = this.#cache.get(serverId);
    const now = Date.now();

    if (cached !== undefined && now - cached.at < PLUGIN_STATE_TTL_MS) {
      return cached.state;
    }

    try {
      const state = await this.#plugins.stateOf(serverId, PLAYERS_PLUGIN);

      this.#cache.set(serverId, { at: now, state });

      return state;
    } catch {
      // Não conseguir ler o acervo NÃO pode impedir a lista de
      // jogadores: a queda para o `playerlist` nativo é justamente
      // o caminho para quando o plugin não está disponível.
      return { id: null, enabled: false };
    }
  }
}

/**
 * Expulsa o jogador.
 *
 * `kick` age sobre quem está CONECTADO — e é isso que se quer
 * aqui: expulsar é tirar da partida agora, não impedir de voltar.
 * Para impedir, o caminho é a BanList.
 *
 * @throws {ApiError} 503 sem RCON.
 */
export async function kickPlayer(
  serverId: string,
  rcon: OpsRcon,
  steamId: string,
  reason: string | null,
): Promise<string> {
  assertConnected(serverId, rcon);

  // As aspas vêm de fora (o motivo é digitado), e uma delas no
  // meio fecharia o argumento cedo. Ver `sanitizeArgument`.
  const clean = sanitizeArgument(reason, 'expulso por um administrador');

  return rcon.send(`kick ${steamId} "${clean}"`);
}

/**
 * Move o jogador para um ponto do mundo.
 *
 * ####  A ALTURA NÃO VEM DAQUI  ####
 *
 * `y` é opcional e o normal é omiti-lo: quem arrasta o boneco num
 * mapa 2D escolhe X e Z, e quem sabe a altura do chão naquele ponto
 * é o servidor. O plugin resolve pelo terreno (e pela água, quando
 * ela está por cima) e devolve a posição FINAL.
 *
 * Mandar o `y` de onde o jogador estava enterraria quem vai para a
 * montanha e largaria no ar quem vai para o vale — preso num caso,
 * caindo no outro.
 *
 * @throws {ApiError} 503 sem RCON, 409 sem o plugin, 502 quando a
 * resposta não bate com o contrato.
 */
export async function teleportPlayer(
  serverId: string,
  rcon: OpsRcon,
  steamId: string,
  target: { readonly x: number; readonly z: number; readonly y?: number | undefined },
): Promise<{ readonly position: Position; readonly heightAdjusted: boolean }> {
  assertConnected(serverId, rcon);

  const raw = await rcon.send(buildTeleportCommand({ steamId, ...target }));
  const parsed = teleportResponseSchema.safeParse(firstJsonLine(raw));

  if (!parsed.success) {
    // Resposta vazia é o sintoma de comando inexistente: o console
    // do Rust não reclama de um comando que não conhece, ele apenas
    // não responde. Dizer isso poupa a caça ao defeito que não
    // existe.
    throw new ApiError(
      'PLUGIN_INVALID_RESPONSE',
      raw.trim() === ''
        ? `O ${PLAYER_ACTIONS_PLUGIN} não respondeu ao teleporte. Ele está ligado neste ` +
          'servidor? O comando vem desse plugin — sem ele, o jogo não tem como mover um ' +
          'jogador para uma posição pelo RCON.'
        : `O ${PLAYER_ACTIONS_PLUGIN} respondeu ao teleporte fora do contrato: ` +
          raw.trim().slice(0, 300),
      502,
    );
  }

  if (!parsed.data.ok) {
    if (parsed.data.error === 'OUTSIDE_WORLD') {
      throw new ApiError(
        'OUTSIDE_WORLD',
        'Esse ponto está fora do mundo. Fora da borda não há terreno, e o jogador cairia sem ' +
          'parar.',
        400,
      );
    }

    if (parsed.data.error === 'PLAYER_NOT_FOUND') {
      throw new ApiError(
        'PLAYER_NOT_FOUND',
        `${steamId} não está mais neste servidor — nem online, nem dormindo.`,
        404,
      );
    }

    throw new ApiError(
      'PLUGIN_ERROR',
      `O ${PLAYER_ACTIONS_PLUGIN} recusou o teleporte: ${parsed.data.error}.`,
      502,
    );
  }

  return { position: parsed.data.position, heightAdjusted: parsed.data.heightAdjusted };
}

/**
 * Põe um item na mão de um jogador CONECTADO.
 *
 * ####  É O MESMO COMANDO DO KIT E DA LOJA  ####
 *
 * `origemz.give`, com os mesmos cinco argumentos e a mesma
 * tradução de erro. Um caminho próprio para a mão do admin
 * (`inventory.give` nativo, por exemplo) entregaria DIFERENTE do
 * que a loja entrega — o nativo cria uma pilha só com o total
 * pedido, e é justamente esse o defeito que o fatiamento do plugin
 * existe para consertar.
 *
 * ####  QUEM NÃO ESTÁ CONECTADO NÃO RECEBE  ####
 *
 * E isso não é limitação do agente: o item nasce no inventário de
 * um `BasePlayer`, que só existe com o jogador no servidor. Dizer
 * "entregue" para quem está offline seria prometer o que não
 * aconteceu — o plugin responde `PLAYER_NOT_FOUND` e a recusa sobe
 * como 404, com a frase.
 *
 * @throws {ApiError} 503 sem RCON, 404 jogador fora, 400 pedido
 * impossível, 409 estado do jogo impede agora, 502 fora do
 * contrato.
 */
export async function givePlayerItem(
  serverId: string,
  rcon: OpsRcon,
  steamId: string,
  input: {
    readonly shortname: string;
    readonly amount: number;
    readonly skinId: string;
    readonly mode: GiveMode;
  },
): Promise<{
  readonly delivered: 'inventory' | 'drop' | 'mixed';
  readonly given: number;
  readonly dropped: number;
}> {
  assertConnected(serverId, rcon);

  const raw = await rcon.send(buildGiveCommand({ steamId, ...input }));
  const parsed = giveResponseSchema.safeParse(firstJsonLine(raw));

  if (!parsed.success) {
    // Resposta vazia é o sintoma de comando inexistente: o console
    // do Rust não reclama de um comando que não conhece, ele
    // apenas se cala. Ver `players-fonte.test.ts` — foi assim que
    // a aba inteira morreu em 04/09/2026.
    throw new ApiError(
      'PLUGIN_INVALID_RESPONSE',
      raw.trim() === ''
        ? `O ${PLAYERS_PLUGIN} não respondeu ao ${PLUGIN_COMMANDS.give}. Ele está carregado ` +
          'neste servidor? O comando vem desse plugin — a aba Plugins mostra se o Oxide ' +
          'conseguiu compilá-lo.'
        : `O ${PLAYERS_PLUGIN} respondeu à entrega fora do contrato: ${raw.trim().slice(0, 300)}`,
      502,
    );
  }

  if (!parsed.data.ok) {
    const { error } = parsed.data;

    throw new ApiError(
      error,
      `Não deu para entregar: ${describeGiveError(error)}.`,
      giveStatus(error),
    );
  }

  return parsed.data;
}

/**
 * O status HTTP de cada recusa do `origemz.give`.
 *
 * A separação não é decorativa: 400 é "conserte o pedido", 409 é
 * "tente de novo daqui a pouco" e 404 é "essa pessoa não está
 * aqui". Responder tudo como 400 mandaria o admin conferir a
 * quantidade quando o problema é que o jogador está dormindo.
 */
function giveStatus(code: string): number {
  switch (code) {
    case 'PLAYER_NOT_FOUND':
      return 404;
    case 'ITEM_NOT_FOUND':
    case 'INVALID_AMOUNT':
    case 'INVALID_ARGS':
    case 'TOO_MANY_STACKS':
      return 400;
    case 'PLAYER_DEAD':
    case 'PLAYER_SLEEPING':
    case 'INVENTORY_FULL':
    case 'DROP_FAILED':
      return 409;
    default:
      // `ITEM_CREATE_FAILED`, `INTERNAL_ERROR` e o que o plugin
      // vier a criar: defeito do outro lado, não do pedido.
      return 502;
  }
}

// ------------------------------------------------------------
//  As duas fontes
// ------------------------------------------------------------

/**
 * O comando saiu e ninguém respondeu a tempo?
 *
 * Reconhecido pelo `code`, e nunca pelo texto da mensagem — é o
 * que `rcon/errors.ts` promete e o que sobrevive a alguém
 * reescrever a frase.
 */
function isRconTimeout(error: unknown): boolean {
  return error instanceof RconError && error.code === 'RCON_TIMEOUT';
}

/**
 * `origemz.players`, página por página.
 *
 * O laço existe porque a resposta é paginada: o frame do WebRCON
 * não negocia tamanho, e um servidor cheio numa resposta só é
 * exatamente o caminho que o trunca. `count` é o total, e é por
 * ele que se sabe quando parar.
 *
 * ####  `null` = O PLUGIN NEM RESPONDEU  ####
 *
 * E isso é diferente de "respondeu errado", que continua sendo
 * 502. Silêncio na PRIMEIRA página é o sintoma do plugin que o
 * Oxide não carregou: o comando não existe no console, e um
 * comando que não existe não produz erro — produz nada. Quem
 * chama trata esse `null` caindo para o `playerlist` nativo.
 *
 * Só a primeira página vale como silêncio. Sumir no meio da
 * paginação é outra coisa — ali JÁ HÁ jogadores lidos, e trocar de
 * fonte no meio devolveria uma lista costurada de duas leituras
 * diferentes. Esse caso continua subindo como falha.
 */
async function readFromPlugin(
  rcon: OpsRcon,
  world: WorldGrid,
): Promise<Omit<PlayersSnapshot, 'plugin' | 'world'> | null> {
  const players: PlayerView[] = [];
  let offset = 0;
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let raw: string;

    try {
      raw = await rcon.send(buildPlayersCommand({ offset, limit: PLAYERS_DEFAULT_LIMIT }));
    } catch (error) {
      // O timeout na primeira página É o silêncio: o comando saiu e
      // ninguém do outro lado respondeu. Qualquer outra falha do
      // RCON (a conexão caiu, o agente está fechando) não é sobre o
      // plugin, e mascará-la com o nativo esconderia o que houve.
      if (page === 0 && isRconTimeout(error)) {
        return null;
      }

      throw error;
    }

    if (page === 0 && raw.trim() === '') {
      // Resposta VAZIA é o mesmo silêncio por outro caminho: o
      // console respondeu o frame, sem conteúdo, porque o comando
      // não existe ali.
      return null;
    }

    const parsed = playersResponseSchema.safeParse(firstJsonLine(raw));

    if (!parsed.success) {
      throw new ApiError(
        'PLUGIN_INVALID_RESPONSE',
        `O ${PLAYERS_PLUGIN} está ligado neste servidor, mas respondeu ao origemz.players em um ` +
          'formato que não bate com o contrato. A versão do plugin e a do agente podem estar ' +
          `diferentes. O que ele respondeu: ${raw.trim().slice(0, 300) || '(vazio)'}`,
        502,
      );
    }

    if (!parsed.data.ok) {
      throw new ApiError(
        'PLUGIN_ERROR',
        `O ${PLAYERS_PLUGIN} recusou o origemz.players: ${parsed.data.error}.`,
        502,
      );
    }

    total = parsed.data.count;
    players.push(...parsed.data.players.map((player) => toPlayerView(player, world)));

    // Página vazia é como o plugin diz que acabou — e o `limit`
    // que volta é o JÁ NORMALIZADO, não o que pedimos.
    if (parsed.data.players.length === 0 || players.length >= total) {
      break;
    }

    offset += parsed.data.limit;
  }

  // O plugin dá tudo menos o endereço — ver o cabeçalho. Dizer
  // isso aqui é o que impede a tela de concluir que o IP sumiu.
  return { source: 'plugin', total, players, missing: ['ip'] };
}

/**
 * `playerlist` — o nativo.
 *
 * Ele responde um array JSON com `SteamID`, `DisplayName`, `Ping`,
 * `ConnectedSeconds` e `Health`. O que não existe ali é POSIÇÃO, e
 * é por isso que o Map View depende do plugin.
 */
async function readNative(rcon: OpsRcon): Promise<Omit<PlayersSnapshot, 'plugin' | 'world'>> {
  const raw = await rcon.send('playerlist');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    throw new ApiError(
      'PLAYERLIST_INVALID_RESPONSE',
      'O comando playerlist respondeu algo que não é JSON. Sem o OrigemZAgent ligado, ele é a ' +
        `única fonte de quem está online. O que ele respondeu: ${raw.trim().slice(0, 300)}`,
      502,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ApiError(
      'PLAYERLIST_INVALID_RESPONSE',
      'O comando playerlist respondeu um JSON que não é uma lista de jogadores.',
      502,
    );
  }

  const players = parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(toNativePlayerView)
    .filter((player): player is PlayerView => player !== null);

  return {
    source: 'nativo',
    total: players.length,
    players,
    // Dito em voz alta para a tela não precisar deduzir o que o
    // travessão significa em cada coluna.
    missing: ['position', 'isAlive', 'isSleeping'],
  };
}

function toPlayerView(
  player: {
    steamId: string;
    name: string;
    health: number;
    isAlive: boolean;
    isSleeping: boolean;
    ping: number;
    connectedSeconds: number;
    position: Position;
  },
  world: WorldGrid,
): PlayerView {
  return {
    steamId: player.steamId,
    name: player.name,
    health: player.health,
    isAlive: player.isAlive,
    isSleeping: player.isSleeping,
    ping: player.ping,
    connectedSeconds: player.connectedSeconds,
    position: player.position,
    // `x` e `z`. O `y` é ALTURA e não entra na grade — usar `(x, y)`
    // é o erro que funciona até alguém subir num prédio.
    grid: gridLabel(player.position.x, player.position.z, world.size),
    // O contrato do plugin não tem endereço. Ver o cabeçalho.
    ip: null,
  };
}

/** `null` quando a linha não tem SteamID que sirva. */
function toNativePlayerView(entry: Record<string, unknown>): PlayerView | null {
  const steamId = asString(entry.SteamID ?? entry.steamId ?? entry.steamid);

  if (steamId === null) {
    return null;
  }

  return {
    steamId,
    name: asString(entry.DisplayName ?? entry.displayName ?? entry.name) ?? steamId,
    health: asNumber(entry.Health ?? entry.health),
    // O `playerlist` não diz nem se o jogador está vivo nem se
    // está dormindo. `null` é a resposta honesta — ver o cabeçalho.
    isAlive: null,
    isSleeping: null,
    ping: asNumber(entry.Ping ?? entry.ping),
    connectedSeconds: asNumber(entry.ConnectedSeconds ?? entry.connectedSeconds),
    position: null,
    // Sem posição não há célula. Inventar uma seria mandar quem
    // procura para um lugar onde o jogador não está.
    grid: null,
    ip: addressToIp(asString(entry.Address ?? entry.address)),
  };
}

/**
 * `"203.0.113.10:53248"` -> `"203.0.113.10"`.
 *
 * A porta é do socket daquela conexão e muda a cada entrada: ela
 * não identifica ninguém, e guardá-la faria dois registros do
 * mesmo jogador parecerem endereços diferentes.
 *
 * O corte é na ÚLTIMA `:` porque um IPv6 vem cheio delas
 * (`[::1]:53248`); os colchetes ficam, e são a forma canônica.
 */
function addressToIp(address: string | null): string | null {
  if (address === null) {
    return null;
  }

  const cut = address.lastIndexOf(':');
  const ip = cut < 0 ? address : address.slice(0, cut);

  return ip === '' ? null : ip;
}

function assertConnected(serverId: string, rcon: OpsRcon): void {
  if (!rcon.isConnected) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      `Sem conexão com o RCON do servidor "${serverId}". Ele pode estar parado ou ainda ` +
        'subindo — quem está online só dá para perguntar ao servidor.',
      503,
    );
  }
}

/**
 * O SteamID às vezes vem como número no `playerlist`.
 *
 * Ele não sobrevive a isso com precisão total, mas descartar a
 * linha seria esconder um jogador que ESTÁ no servidor. Melhor
 * lê-lo e deixar quem for banir passar pela validação de 17
 * dígitos.
 */
function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
